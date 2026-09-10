export type PreparationPhase = 'authenticating' | 'copying_archive' | 'inspecting_archive' | 'extracting_files' | 'verifying_components' | 'cleaning_up'
export type PreparationStatus = 'running' | 'stopping' | 'cleaning_up' | 'validated' | 'cancelled' | 'failed' | 'cleanup_failed' | 'cleaned'
export interface OcrPackageSelection { archivePath: string; descriptorPath: string; signaturePath: string }
export interface OcrPreparationJob {
  id: string
  status: PreparationStatus
  progress: { phase: PreparationPhase; completedBytes: number; totalBytes: number | null; completedFiles: number; totalFiles: number | null } | null
  error: { code: string; message: string } | null
}
export interface OcrInstallationSnapshot {
  canPrepare: boolean
  unavailableReason: string | null
  closing: boolean
  job: OcrPreparationJob | null
}
