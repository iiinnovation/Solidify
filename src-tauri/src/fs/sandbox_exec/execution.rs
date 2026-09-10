//! Per-batch exclusion and cancellation from preparation through result acceptance.
use super::types::{ExtractMethod, FailureCode, SandboxError};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CallIdentity {
    pub task_id: String,
    pub run_id: String,
    pub call_id: String,
}

impl CallIdentity {
    pub fn new(task: &str, run: &str, call: &str) -> Result<Self, SandboxError> {
        for value in [task, run, call] {
            if value.is_empty()
                || value.len() > 200
                || !value
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            {
                return Err(SandboxError::new(
                    FailureCode::InvalidInput,
                    "无效的任务执行身份",
                ));
            }
        }
        Ok(Self {
            task_id: task.into(),
            run_id: run.into(),
            call_id: call.into(),
        })
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionPhase {
    Preparing,
    Running,
    Stopping,
    Finished,
}

struct Active {
    #[cfg(unix)]
    process_lock: Option<Arc<std::fs::File>>,
    call: CallIdentity,
    batch_id: String,
    phase: ExecutionPhase,
    deadline: Instant,
    progress: Option<DocumentProgress>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentProgress {
    pub execution_id: String,
    pub task_id: String,
    pub run_id: String,
    pub relative_path: String,
    pub method: ExtractMethod,
    pub phase: ExecutionPhase,
    pub completed_pages: u32,
    pub total_pages: Option<u32>,
}

#[derive(Default)]
struct State {
    #[cfg(unix)]
    process_locks: HashMap<String, std::sync::Weak<std::fs::File>>,
    shutting_down: bool,
    active: HashMap<String, Active>,
    cancelled: HashSet<CallIdentity>,
    stopped_runs: HashSet<(String, String)>,
    mutating_tasks: HashSet<String>,
    attempted_documents: HashSet<(String, String, String, ExtractMethod)>,
}

#[derive(Default, Clone)]
pub struct ExecutionManager {
    state: Arc<Mutex<State>>,
    #[cfg(unix)]
    process_locks: Option<Arc<super::task_lock::TaskLocks>>,
}

impl ExecutionManager {
    pub fn for_database(path: &std::path::Path) -> Result<Self, SandboxError> {
        #[cfg(unix)]
        {
            return Ok(Self {
                state: Default::default(),
                process_locks: Some(Arc::new(super::task_lock::TaskLocks::open(path)?)),
            });
        }
        #[cfg(not(unix))]
        {
            let _ = path;
            Ok(Self::default())
        }
    }

    #[cfg(unix)]
    fn acquire_task_lock(
        &self,
        state: &mut State,
        task: &str,
    ) -> Result<Option<Arc<std::fs::File>>, SandboxError> {
        let Some(locks) = &self.process_locks else {
            return Ok(None);
        };
        state
            .process_locks
            .retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = state
            .process_locks
            .get(task)
            .and_then(|lock| lock.upgrade())
        {
            return Ok(Some(lock));
        }
        let lock = locks.acquire(task)?;
        state
            .process_locks
            .insert(task.into(), Arc::downgrade(&lock));
        Ok(Some(lock))
    }
    fn lock(&self) -> Result<MutexGuard<'_, State>, SandboxError> {
        self.state.lock().map_err(|_| {
            SandboxError::new(
                FailureCode::StopFailed,
                "执行登记异常，外部解析已停止接受新调用",
            )
        })
    }

    /// Call before staging. The trusted caller has already checked the lease.
    /// A second lease check is required before start and before accept.
    pub fn begin(
        &self,
        call: CallIdentity,
        batch_id: &str,
        budget: Duration,
    ) -> Result<ExecutionGuard, SandboxError> {
        self.begin_inner(call, batch_id, budget, None)
    }

    pub fn begin_document(
        &self,
        call: CallIdentity,
        batch_id: &str,
        budget: Duration,
        relative_path: &str,
        method: ExtractMethod,
    ) -> Result<ExecutionGuard, SandboxError> {
        self.begin_inner(call, batch_id, budget, Some((relative_path, method)))
    }

    fn begin_inner(
        &self,
        call: CallIdentity,
        batch_id: &str,
        budget: Duration,
        document: Option<(&str, ExtractMethod)>,
    ) -> Result<ExecutionGuard, SandboxError> {
        let mut state = self.lock()?;
        if state.shutting_down {
            return Err(SandboxError::new(
                FailureCode::Cancelled,
                "应用正在退出，不再接受转换",
            ));
        }
        let document_key = document.map(|(path, method)| {
            (
                call.task_id.clone(),
                call.run_id.clone(),
                path.to_owned(),
                method,
            )
        });
        if document_key
            .as_ref()
            .is_some_and(|key| state.attempted_documents.contains(key))
        {
            return Err(SandboxError::new(
                FailureCode::RepeatLimit,
                "本次运行已尝试过此文件的转换方法，请通过任务重试启动新的运行",
            ));
        }
        if state.mutating_tasks.contains(&call.task_id) {
            return Err(SandboxError::new(
                FailureCode::ExecutionBusy,
                "任务正在提交状态变更，请稍后再试",
            ));
        }
        if state.cancelled.contains(&call)
            || state
                .stopped_runs
                .contains(&(call.task_id.clone(), call.run_id.clone()))
        {
            return Err(SandboxError::new(FailureCode::Cancelled, "此次解析已取消"));
        }
        if state.active.values().any(|active| {
            active.call == call
                || (active.call.task_id == call.task_id && active.batch_id == batch_id)
        }) {
            return Err(SandboxError::new(
                FailureCode::ExecutionBusy,
                "批次仍有转换正在执行或停止，请等待回收",
            ));
        }
        // A compromised renderer cannot grow cancellation/active state forever.
        // Closed identities remain closed for this app instance: do not evict
        // tombstones and accidentally accept a late invocation.
        if state.active.len() >= 32
            || state.cancelled.len() + state.stopped_runs.len() + state.attempted_documents.len()
                >= 100_000
        {
            return Err(SandboxError::new(
                FailureCode::ExecutionBusy,
                "隔离执行登记达到实例上限",
            ));
        }
        let deadline = Instant::now()
            .checked_add(budget)
            .ok_or_else(|| SandboxError::new(FailureCode::InvalidInput, "无效执行时限"))?;
        let id = Uuid::new_v4().to_string();
        #[cfg(unix)]
        let process_lock = self.acquire_task_lock(&mut state, &call.task_id)?;
        let progress = document.map(|(path, method)| DocumentProgress {
            execution_id: id.clone(),
            task_id: call.task_id.clone(),
            run_id: call.run_id.clone(),
            relative_path: path.into(),
            method,
            phase: ExecutionPhase::Preparing,
            completed_pages: 0,
            total_pages: None,
        });
        if let Some(key) = document_key {
            state.attempted_documents.insert(key);
        }
        state.active.insert(
            id.clone(),
            Active {
                #[cfg(unix)]
                process_lock,
                call,
                batch_id: batch_id.into(),
                phase: ExecutionPhase::Preparing,
                deadline,
                progress,
            },
        );
        Ok(ExecutionGuard {
            manager: self.clone(),
            id,
        })
    }

    /// IPC callers must first prove this task/run belongs to their task lease.
    /// Remember cancellation even if begin() has not reached registration yet.
    pub fn cancel_call(&self, call: &CallIdentity) -> Result<(), SandboxError> {
        let mut state = self.lock()?;
        if state.cancelled.len() >= 100_000 {
            return Err(SandboxError::new(
                FailureCode::ExecutionBusy,
                "取消登记达到实例上限",
            ));
        }
        state.cancelled.insert(call.clone());
        for active in state
            .active
            .values_mut()
            .filter(|entry| &entry.call == call)
        {
            if active.phase != ExecutionPhase::Finished {
                active.phase = ExecutionPhase::Stopping;
            }
        }
        Ok(())
    }

    pub fn stop_run(&self, task: &str, run: &str) -> Result<(), SandboxError> {
        let mut state = self.lock()?;
        if state.stopped_runs.len() >= 100_000 {
            return Err(SandboxError::new(
                FailureCode::ExecutionBusy,
                "停止登记达到实例上限",
            ));
        }
        state.stopped_runs.insert((task.into(), run.into()));
        for active in state
            .active
            .values_mut()
            .filter(|entry| entry.call.task_id == task && entry.call.run_id == run)
        {
            if active.phase != ExecutionPhase::Finished {
                active.phase = ExecutionPhase::Stopping;
            }
        }
        Ok(())
    }

    pub fn batch_is_active(&self, task: &str, batch: &str) -> Result<bool, SandboxError> {
        Ok(self
            .lock()?
            .active
            .values()
            .any(|entry| entry.call.task_id == task && entry.batch_id == batch))
    }

    /// Read-only current state, not persisted recovery state or task success.
    /// The execution guard retains the entry until processes and files retire.
    pub fn document_progress(&self, task: &str) -> Result<Vec<DocumentProgress>, SandboxError> {
        let state = self.lock()?;
        let mut progress: Vec<_> = state
            .active
            .values()
            .filter(|entry| entry.call.task_id == task)
            .filter_map(|entry| {
                entry.progress.as_ref().map(|progress| {
                    let mut progress = progress.clone();
                    progress.phase = entry.phase;
                    progress
                })
            })
            .collect();
        progress.sort_by(|left, right| left.execution_id.cmp(&right.execution_id));
        Ok(progress)
    }

    /// Acquire before opening a SQLite write transaction. Unlike a check-then-
    /// write boolean, this fence prevents begin() until the transaction ends.
    /// No mutex is held across database I/O or process supervision.
    pub fn mutation_when_idle(&self, task: &str) -> Result<TaskMutationGuard, SandboxError> {
        self.reserve_mutation(task, false)
    }

    /// Reserve the task before validating a stop action. Merely reserving does
    /// not cancel anything: stale/unauthorized actions must fail without impact.
    pub fn mutation_for_stop(&self, task: &str) -> Result<TaskMutationGuard, SandboxError> {
        self.reserve_mutation(task, true)
    }

    fn reserve_mutation(
        &self,
        task: &str,
        allow_active: bool,
    ) -> Result<TaskMutationGuard, SandboxError> {
        let mut state = self.lock()?;
        if state.shutting_down {
            return Err(SandboxError::new(
                FailureCode::Cancelled,
                "应用正在退出，不再接受任务变更",
            ));
        }
        if state.mutating_tasks.contains(task)
            || (!allow_active
                && state
                    .active
                    .values()
                    .any(|entry| entry.call.task_id == task))
        {
            return Err(SandboxError::new(
                FailureCode::ExecutionBusy,
                "任务仍有转换正在执行或回收，暂不能提交检查点或释放批次",
            ));
        }
        state.mutating_tasks.insert(task.into());
        #[cfg(unix)]
        let process_lock = match self.acquire_task_lock(&mut state, task) {
            Ok(lock) => lock,
            Err(error) => {
                state.mutating_tasks.remove(task);
                return Err(error);
            }
        };
        Ok(TaskMutationGuard {
            #[cfg(unix)]
            _process_lock: process_lock,
            manager: self.clone(),
            task: task.into(),
        })
    }

    /// Irreversible per-instance fence. Called before the background drain;
    /// existing guards must retire naturally after subprocess/file cleanup.
    pub fn begin_shutdown(&self) -> Result<(), SandboxError> {
        let mut state = self.lock()?;
        state.shutting_down = true;
        for entry in state.active.values_mut() {
            if entry.phase != ExecutionPhase::Finished {
                entry.phase = ExecutionPhase::Stopping;
            }
        }
        Ok(())
    }

    pub fn shutdown_drained(&self) -> Result<bool, SandboxError> {
        let state = self.lock()?;
        Ok(state.shutting_down && state.active.is_empty() && state.mutating_tasks.is_empty())
    }
}

pub struct TaskMutationGuard {
    #[cfg(unix)]
    _process_lock: Option<Arc<std::fs::File>>,
    manager: ExecutionManager,
    task: String,
}

impl TaskMutationGuard {
    /// A run termination must never cancel another run's converter.
    pub fn cancel_run_and_wait(
        &self,
        run: &str,
        on_stopping: impl Fn(bool),
    ) -> Result<(), SandboxError> {
        if self
            .manager
            .lock()?
            .active
            .values()
            .any(|entry| entry.call.task_id == self.task && entry.call.run_id != run)
        {
            return Err(SandboxError::new(
                FailureCode::ExecutionBusy,
                "其他运行仍有转换正在执行",
            ));
        }
        self.manager.stop_run(&self.task, run)?;
        self.cancel_and_wait(on_stopping)
    }

    /// Run only on a background thread, with no SQLite transaction open.
    /// Stop delay is observable, but never releases a live task's fence.
    pub fn cancel_and_wait(&self, on_stopping: impl Fn(bool)) -> Result<(), SandboxError> {
        let had_active = {
            let mut state = self.manager.lock()?;
            let mut any = false;
            for active in state
                .active
                .values_mut()
                .filter(|entry| entry.call.task_id == self.task)
            {
                any = true;
                active.phase = ExecutionPhase::Stopping;
            }
            any
        };
        if !had_active {
            return Ok(());
        }
        on_stopping(false);
        let started = Instant::now();
        let mut notified = false;
        loop {
            if !self
                .manager
                .lock()?
                .active
                .values()
                .any(|entry| entry.call.task_id == self.task)
            {
                return Ok(());
            }
            if !notified && started.elapsed() >= Duration::from_secs(2) {
                notified = true;
                on_stopping(true);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for TaskMutationGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.manager.state.lock() {
            state.mutating_tasks.remove(&self.task);
        }
    }
}

/// Kept by the supervisor until it has reaped all processes and cleaned up.
/// Dropping a guard is NOT a way to kill a process: the platform runner must
/// hold it outside its child-process guard so child cleanup runs first.
pub struct ExecutionGuard {
    manager: ExecutionManager,
    id: String,
}

impl ExecutionGuard {
    pub fn task_lock(&self) -> Result<Option<Arc<std::fs::File>>, SandboxError> {
        #[cfg(unix)]
        {
            return Ok(self
                .manager
                .lock()?
                .active
                .get(&self.id)
                .and_then(|active| active.process_lock.clone()));
        }
        #[cfg(not(unix))]
        {
            Ok(None)
        }
    }
    pub fn report_pages(&self, completed: u32, total: u32) -> Result<(), SandboxError> {
        let mut state = self.manager.lock()?;
        let active = state
            .active
            .get_mut(&self.id)
            .ok_or_else(|| SandboxError::new(FailureCode::Cancelled, "执行已结束"))?;
        check_active(active)?;
        if active.phase != ExecutionPhase::Running {
            return Err(SandboxError::new(
                FailureCode::InvalidInput,
                "未启动的转换不能报告页进度",
            ));
        }
        let progress = active
            .progress
            .as_mut()
            .ok_or_else(|| SandboxError::new(FailureCode::InvalidInput, "没有文档转换登记"))?;
        if total == 0
            || completed > total
            || completed < progress.completed_pages
            || progress
                .total_pages
                .is_some_and(|previous| previous != total)
        {
            return Err(SandboxError::new(
                FailureCode::InvalidInput,
                "转换页进度无效",
            ));
        }
        progress.total_pages = Some(total);
        progress.completed_pages = completed;
        Ok(())
    }
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn check(&self) -> Result<(), SandboxError> {
        let state = self.manager.lock()?;
        let active = state
            .active
            .get(&self.id)
            .ok_or_else(|| SandboxError::new(FailureCode::Cancelled, "执行已结束"))?;
        check_active(active)
    }

    pub fn start(&self) -> Result<(), SandboxError> {
        let mut state = self.manager.lock()?;
        let active = state
            .active
            .get_mut(&self.id)
            .ok_or_else(|| SandboxError::new(FailureCode::Cancelled, "执行已结束"))?;
        check_active(active)?;
        if active.phase != ExecutionPhase::Preparing {
            return Err(SandboxError::new(FailureCode::ExecutionBusy, "执行已启动"));
        }
        active.phase = ExecutionPhase::Running;
        Ok(())
    }

    /// Linearize success with cancellation. The callback performs the final
    /// short-lived DB lease/state check, never a blocking conversion or wait.
    pub fn accept<T>(
        &self,
        validate_and_build: impl FnOnce() -> Result<T, SandboxError>,
    ) -> Result<T, SandboxError> {
        let mut state = self.manager.lock()?;
        let active = state
            .active
            .get_mut(&self.id)
            .ok_or_else(|| SandboxError::new(FailureCode::Cancelled, "执行已结束"))?;
        check_active(active)?;
        if active.phase != ExecutionPhase::Running {
            return Err(SandboxError::new(
                FailureCode::InvalidInput,
                "未启动的转换不能提交结果",
            ));
        }
        let value = validate_and_build()?;
        active.phase = ExecutionPhase::Finished;
        Ok(value)
    }
}

fn check_active(active: &Active) -> Result<(), SandboxError> {
    if matches!(
        active.phase,
        ExecutionPhase::Stopping | ExecutionPhase::Finished
    ) {
        return Err(SandboxError::new(
            FailureCode::Cancelled,
            "此次解析已停止或结束",
        ));
    }
    if Instant::now() >= active.deadline {
        return Err(SandboxError::new(
            FailureCode::TimedOut,
            "文档转换超过执行时限",
        ));
    }
    Ok(())
}

impl Drop for ExecutionGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.manager.state.lock() {
            if let Some(active) = state.active.remove(&self.id) {
                state.cancelled.insert(active.call);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn call(id: &str) -> CallIdentity {
        CallIdentity::new("task", "run", id).unwrap()
    }

    #[test]
    fn shutdown_cancels_all_phases_and_waits_for_cleanup_and_existing_mutations() {
        let manager = ExecutionManager::default();
        let mutation = manager.mutation_when_idle("mutating").unwrap();
        let preparing = manager
            .begin(call("preparing"), "batch-a", Duration::from_secs(10))
            .unwrap();
        let running = manager
            .begin(
                CallIdentity::new("other", "run", "running").unwrap(),
                "batch-b",
                Duration::from_secs(10),
            )
            .unwrap();
        running.start().unwrap();
        assert!(!manager.shutdown_drained().unwrap());
        manager.begin_shutdown().unwrap();
        manager.begin_shutdown().unwrap();
        assert!(preparing.start().is_err());
        assert!(running.check().is_err());
        assert!(running.accept(|| Ok(())).is_err());
        assert!(manager
            .clone()
            .begin(call("late"), "batch-c", Duration::from_secs(10))
            .is_err());
        assert!(manager.mutation_when_idle("new-task").is_err());
        drop(preparing);
        drop(running);
        assert!(
            !manager.shutdown_drained().unwrap(),
            "existing mutation still owns its transaction fence"
        );
        drop(mutation);
        assert!(manager.shutdown_drained().unwrap());
        assert!(manager
            .begin(call("after-drain"), "batch-d", Duration::from_secs(10))
            .is_err());
        let independent = ExecutionManager::default();
        assert!(independent
            .begin(call("separate-instance"), "batch", Duration::from_secs(10))
            .is_ok());
    }

    #[test]
    fn page_progress_is_scoped_monotonic_and_retained_until_reaped() {
        let manager = ExecutionManager::default();
        let guard = manager
            .begin_document(
                call("pages"),
                "private-batch",
                Duration::from_secs(10),
                "scan.pdf",
                ExtractMethod::PdfOcr,
            )
            .unwrap();
        let other = manager
            .begin_document(
                CallIdentity::new("other", "run", "image").unwrap(),
                "other-batch",
                Duration::from_secs(10),
                "other.png",
                ExtractMethod::ImageOcr,
            )
            .unwrap();
        let progress = manager.document_progress("task").unwrap();
        assert_eq!(progress.len(), 1);
        assert_eq!(progress[0].phase, ExecutionPhase::Preparing);
        assert_eq!(progress[0].total_pages, None);
        assert!(guard.report_pages(0, 2).is_err());
        guard.start().unwrap();
        guard.report_pages(0, 2).unwrap();
        guard.report_pages(1, 2).unwrap();
        for (completed, total) in [(0, 2), (3, 2), (1, 3), (0, 0)] {
            assert!(guard.report_pages(completed, total).is_err());
        }
        assert_eq!(
            manager.clone().document_progress("task").unwrap()[0].completed_pages,
            1
        );
        manager.cancel_call(&call("pages")).unwrap();
        assert!(guard.report_pages(2, 2).is_err());
        let progress = manager.document_progress("task").unwrap();
        assert_eq!(progress[0].phase, ExecutionPhase::Stopping);
        assert_eq!(progress[0].completed_pages, 1);
        assert!(!serde_json::to_string(&progress)
            .unwrap()
            .contains("private-batch"));
        drop(guard);
        assert!(manager.document_progress("task").unwrap().is_empty());
        assert_eq!(manager.document_progress("other").unwrap().len(), 1);
        other.start().unwrap();
        other.report_pages(1, 1).unwrap();
        other.accept(|| Ok(())).unwrap();
        assert_eq!(
            manager.document_progress("other").unwrap()[0].phase,
            ExecutionPhase::Finished
        );
        drop(other);
        assert!(manager.document_progress("other").unwrap().is_empty());
        assert!(ExecutionManager::default()
            .document_progress("task")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn task_mutation_and_execution_are_atomic_and_isolated() {
        let manager = ExecutionManager::default();
        let mutation = manager.mutation_when_idle("task").unwrap();
        assert!(manager
            .begin(call("blocked"), "batch", Duration::from_secs(10))
            .is_err());
        assert!(manager.mutation_when_idle("task").is_err());
        let other = manager
            .begin(
                CallIdentity::new("other", "run", "one").unwrap(),
                "batch",
                Duration::from_secs(10),
            )
            .unwrap();
        drop(mutation);
        let running = manager
            .begin(call("running"), "batch", Duration::from_secs(10))
            .unwrap();
        assert!(manager.mutation_when_idle("task").is_err());
        manager.cancel_call(&call("running")).unwrap();
        assert!(
            manager.mutation_when_idle("task").is_err(),
            "cancellation does not mean reaped"
        );
        drop(running);
        assert!(manager.mutation_when_idle("task").is_ok());
        drop(other);
    }

    #[test]
    fn early_cancel_survives_delayed_registration() {
        let manager = ExecutionManager::default();
        manager.cancel_call(&call("early")).unwrap();
        assert!(matches!(
            manager.begin(call("early"), "batch", Duration::from_secs(1)),
            Err(SandboxError {
                code: FailureCode::Cancelled,
                ..
            })
        ));
    }

    #[test]
    fn document_attempt_budget_cannot_be_reset_by_new_call_or_batch() {
        let manager = ExecutionManager::default();
        let first = manager
            .begin_document(
                call("one"),
                "batch",
                Duration::from_secs(1),
                "scan.pdf",
                ExtractMethod::PdfOcr,
            )
            .unwrap();
        drop(first);
        assert!(matches!(
            manager.begin_document(
                call("two"),
                "new-batch",
                Duration::from_secs(1),
                "scan.pdf",
                ExtractMethod::PdfOcr
            ),
            Err(SandboxError {
                code: FailureCode::RepeatLimit,
                ..
            })
        ));
        let retry = CallIdentity::new("task", "new-run", "three").unwrap();
        assert!(manager
            .begin_document(
                retry,
                "retry-batch",
                Duration::from_secs(1),
                "scan.pdf",
                ExtractMethod::PdfOcr
            )
            .is_ok());
    }

    #[test]
    fn cancellation_during_preparation_blocks_start_and_result() {
        let manager = ExecutionManager::default();
        let guard = manager
            .begin(call("one"), "batch", Duration::from_secs(10))
            .unwrap();
        manager.cancel_call(&call("one")).unwrap();
        assert_eq!(guard.start().unwrap_err().code, FailureCode::Cancelled);
        assert!(guard.accept(|| Ok("late result")).is_err());
        assert!(manager.batch_is_active("task", "batch").unwrap());
        assert!(manager
            .begin(call("two"), "batch", Duration::from_secs(1))
            .is_err());
        drop(guard);
        assert!(!manager.batch_is_active("task", "batch").unwrap());
    }

    #[test]
    fn cancelling_one_run_does_not_cancel_another_and_blocks_late_calls() {
        let manager = ExecutionManager::default();
        let guard = manager
            .begin(call("one"), "batch", Duration::from_secs(10))
            .unwrap();
        let other = manager
            .begin(
                CallIdentity::new("task-other", "run-other", "two").unwrap(),
                "batch",
                Duration::from_secs(10),
            )
            .unwrap();
        guard.start().unwrap();
        other.start().unwrap();
        manager.stop_run("task", "run").unwrap();
        assert!(guard.accept(|| Ok(())).is_err());
        assert!(other.accept(|| Ok(())).is_ok());
        assert!(manager
            .begin(call("late"), "new-batch", Duration::from_secs(10))
            .is_err());
    }

    #[test]
    fn deadline_and_final_lease_check_prevent_accepting_invalid_results() {
        let manager = ExecutionManager::default();
        let expired = manager
            .begin(call("expired"), "batch-1", Duration::ZERO)
            .unwrap();
        assert_eq!(expired.start().unwrap_err().code, FailureCode::TimedOut);
        let guard = manager
            .begin(call("valid"), "batch-2", Duration::from_secs(1))
            .unwrap();
        guard.start().unwrap();
        assert_eq!(
            guard
                .accept::<()>(|| Err(SandboxError::new(
                    FailureCode::LeaseInvalid,
                    "lease expired"
                )))
                .unwrap_err()
                .code,
            FailureCode::LeaseInvalid
        );
        manager.cancel_call(&call("valid")).unwrap();
        assert!(guard.accept(|| Ok(())).is_err());
    }
}
