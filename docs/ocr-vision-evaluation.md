# Apple Vision OCR 候选评估

日期：2026-09-10。按 [实施方案 A0/A2](sandbox-execution-plane-design.md) 评估其他引擎，承接 [完整模型依赖基线](ocr-model-dependency-evaluation.md)。当前是开发诊断，尚未接入产品 OCR 路由或组件安装器。

## 固定条件

复用原质量集 32 张 PNG，三种字体、两种版式、四种金额及 PingFang 配对模糊图。逐文件与完整依赖的 Tesseract 原图基线比对 SHA-256，生成器哈希也必须一致；不改变图像、按字段挑选候选或给引擎提供金额答案。

探针调用系统 `VNRecognizeTextRequest` revision 3、accurate、`zh-Hans`/`en-US`，禁用语言纠错和自动语言选择，`minimumTextHeight=0`，请求 CPU-only。该 CPU 设置在 macOS 14 起已弃用，本轮编译产生相应警告，不据此宣称已验证新版计算设备契约。每个检测框只取第一候选，按框结果原顺序逐行输出，保留框坐标和置信度；不合并跨行金额、不补标点/币种，不用低置信度筛选掩盖错误。

评分直接复用 Rust 现有 `amount_exact`：仅去空白，要求整行金额或带“合同金额”的整行精确匹配，并拒绝重复匹配。货币全/半宽、数字和标点均不归一化；三条控制短句单独评分。比较对象是前轮完整依赖 Tesseract 的原图 PSM 3，不是各预处理策略的择优结果。

系统为 macOS 26.6.2 (25G83)、x86_64。报告记录系统版本、请求修订号、支持语言、实际探针二进制/源码及测试代码哈希。Vision 模型由操作系统管理，本轮没有拿到独立可固定的模型文件哈希；请求 revision 和 OS build 不能替代模型来源锁定。没有向生产信任列表添加任何内容。

## 隔离兼容性

在既有 `ProcessJob`、监督器和 Seatbelt 策略下测试了三个输入入口，均在第一张图片返回识别结果以前失败：

| 入口 | 进程观测 | 质量样本数 | 证据 |
|---|---|---:|---|
| PNG URL | 无退出码、无 stdout/stderr，系统报告 SIGSEGV | 0 | [报告](ocr-quality/2026-09-10-vision-seatbelt.json) |
| PNG Data | 同上 | 0 | [报告](ocr-quality/2026-09-10-vision-seatbelt-data.json) |
| RGBA → CGImage | 同上 | 0 | [报告](ocr-quality/2026-09-10-vision-seatbelt-rgba.json) |

报告的 `runCount` 表示成功得到质量行的次数；三份各尝试了一个进程，不能将 `amountExactCount=0` 解读为 0/32 准确率。全部失败后都检查了暂存输入哈希和空 work，未扩大文件、Mach 服务或网络权限。

URL/Data 栈指向 ImageIO 的 `ApplicationOptIn`/`CFBundleGetInfoDictionary`；RGBA 栈改为 Core Image 的 `NSUserDefaults`/`CFBundleGetIdentifier`。摘录见 [已去除个人标识的崩溃摘要](ocr-quality/2026-09-10-vision-crash-summary.json)，包含原始系统报告哈希。它们提示主 bundle 元数据初始化问题，但尚未证明具体缺少哪项权限，也没有证明增加某项权限即可安全运行。

RGBA 探测仅用 Rust `image` 解码同一张 PNG，检查 1600×700、alpha 全为 255，以原始 RGBA8 构造 `CGImage`，区分图片解码与 Vision/Core Image 初始化。测试借用内部暂存入口保存原始字节，以固定 `--rgba` 参数标明编码；这不是新增生产图片格式，也没有绕过生产图片校验。此入口同样在框架初始化时失败，未产生可比较的 OCR 文本。

## 宿主诊断边界

另行运行同一开发探针的宿主对照。它只处理已生成的合成图片，使用私有 HOME/TMPDIR 和固定环境，单个直接子进程 wall 60 秒、CPU 30 秒、单文件 64 MiB；回收直接子进程后收集输出，输出超过 64 KiB 则标为失败。输出长度检查发生在收集之后，不是增量硬限制。首个失败即停止，最多尝试 32 张；宿主分支没有整轮 600 秒截止，最坏时长上界还包含准备工作。

该路径没有 Seatbelt 文件/网络限制，不保证 XPC 服务生命周期、所有宿主缓存位置或无隐式系统服务调用。报告明确标注 `HOST-ONLY-no-confinement`；仅凭该路径成功不能宣称离线组件、网络拒绝、用户文档范围、取消或崩溃回收通过。它的目的仅是评估质量，判断是否值得继续研究平台适配。

## 宿主质量结果

[完整报告](ocr-quality/2026-09-10-vision-host-quality.json) 包含全部 32 项结果。进程均正常完成，输入哈希和 work 无遗留检查通过，stderr 均为空；最终沿用严格质量门槛失败，测试退出码 101。测试 339.17 秒，报告写出前计时 338.916 秒，包含生成、编译和逐张进程启动/框架初始化，不作为生产吞吐基准。

| 金额组 | Vision 严格命中 |
|---|---:|
| 中文小写金额 | 8/8 |
| 中文大写金额 | 8/8 |
| 普通数字小数 | 8/8 |
| 币种符号金额 | 1/8 |
| 合计 | 25/32 |

前轮完整依赖的 Tesseract 原图基线为 8/32；Vision 相对它有 17 项严格改善、0 项严格退化。三条控制短句全部命中，共 96/96。这里的 32 张包含相关的字体、版式和模糊对照，不代表 32 份独立真实业务文档。

7 项严格失败全部是将 `￥98,765.40` 输出为 `¥98,765.40`；只有 PingFang 普通行模糊图保留全角币种符号。独立核对时仅将 `￥` 映射为 `¥`，32/32 可通过同一整行检查，没有观察到数字、分隔符或单位变化。该诊断不替代严格评分，也不是一般金额语义解析器；没有据此修改 OCR 原文或放宽旧测试。

报告的测试代码、Swift 探针、宿主运行器、生成器及旧基线 SHA-256 已核对；全部 32 项输入、原评分、改善/退化、控制短句和汇总另行复算通过。探针保留置信度，但本轮没有进行置信度校准，不能把这些数值用作自动放行金额的依据。

## 决策与验证

Vision 在本批合成样本上有进一步评估价值，但同时存在两个独立阻断：严格币种原文仍不满足门槛，且现有隔离策略下三个入口均在框架初始化时失败。没有启用宿主执行作为产品降级路径，也没有修改生产组件、默认 OCR 或 Seatbelt 权限。

下一步优先用最小 CoreFoundation/bundle 探针确认框架初始化所需的具体依赖，评估能否在限定组件文件和元数据范围内运行；任何适配都须重新通过文件范围、网络、取消和崩溃回收测试。若不能满足边界，应继续评估可固定模型的其他引擎，而非把宿主运行器接入产品。OS 管理模型的版本来源、目标 macOS 范围和离线可用性也仍需独立验收。

本轮未扩展金额数值、字号、真实扫描、PDF/JPEG 或完整桌面任务，不能从这批结果推定这些范围已达标。原失败基线及三个隔离失败报告均保留。Rust 沙箱模块普通测试 53 通过、16 忽略，包含新加入的三个真实候选测试入口；Swift 优化编译通过并保留 CPU API 弃用警告，格式与差异检查通过。没有重跑全量 Rust、监督故障矩阵或桌面验收，也没有将候选测试包装成生产组件验收。

## 复现

先构建应用二进制，隔离测试须在支持 Seatbelt 的外层执行。每次使用新的报告路径，失败也保留报告。

```sh
cargo build --offline --manifest-path src-tauri/Cargo.toml --bin solidify
SOLIDIFY_TEST_OCR_REPORT=/absolute/path/to/new-isolated-report.json cargo test --offline --manifest-path src-tauri/Cargo.toml --lib live_vision_ocr_candidate -- --ignored --nocapture
SOLIDIFY_TEST_OCR_REPORT=/absolute/path/to/new-raw-report.json cargo test --offline --manifest-path src-tauri/Cargo.toml --lib live_vision_raw_pixel_candidate -- --ignored --nocapture
SOLIDIFY_TEST_OCR_REPORT=/absolute/path/to/new-host-report.json cargo test --offline --manifest-path src-tauri/Cargo.toml --lib live_vision_host_quality_diagnostic -- --ignored --nocapture
```

当前隔离测试使用 Data 或 RGBA 入口；最初 URL 崩溃记录保留为历史诊断。宿主命令明确属于不受产品隔离策略约束的开发测试，不能用于用户业务文档。
