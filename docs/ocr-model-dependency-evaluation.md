# OCR 模型依赖补全对照

日期：2026-09-10。承接 [预处理受控对照](ocr-preprocessing-evaluation.md)。本轮补齐开发组件的固定模型依赖，同时收紧共用组件验证器；生产 OCR 仍未激活。

## 修复范围

组件验证器此前只要求 `chi_sim` 和 `eng` 文件存在，来源返回值也写死为这两个模型。现在读取哈希已通过的同一文件描述符中的 classic traineddata 目录/config，从固定主语言递归解析 `tessedit_load_sublangs`，要求每个依赖具备语言版本、文件项和正确哈希。未登记模型、缺失传递依赖及不支持的配置会阻断组件验证；循环引用去重后终止。安装准备与每次运行前的复核共用此检查。

这是容器和配置检查，不验证神经网络内容，也不替代引擎 probe。受支持的格式、大小和配置语法见 [组件包契约](ocr-component-package.md)。运行时 `languageVersions` 包含主语言及全部所需依赖；开发组件各项均由实际复制后的 SHA-256 生成。它表示经验证的所需模型来源，不宣称追踪到了每个文字的模型贡献，也不把进程退出 0 等同全部语言成功加载。

## 固定来源

三个模型均来自 `tesseract-ocr/tessdata_best` 的同一提交 `e12c65a915945e4c28e237a9b52bc4a8f39a0cec`，不是混用宿主模型。开发构造器对每份复制后的文件检查以下固定哈希，组件验证器再检查其清单哈希。

| 模型 | SHA-256 |
|---|---|
| chi_sim | `4fef2d1306c8e87616d4d3e4c6c67faf5d44be3342290cf8f2f0f6e3aa7e735b` |
| eng | `8280aed0782fe27257a68ea10fe7ef324ca0f8d85bd2fd145d1c2b560bcb66ba` |
| chi_sim_vert | `ea672a78157199c333aa12ec4e74550077689b545df5fc770903716850c8b2e5` |

新增文件的固定下载地址：<https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/e12c65a915945e4c28e237a9b52bc4a8f39a0cec/chi_sim_vert.traineddata>。下载仅供开发实验，没有安装到宿主或生产组件目录。

原 `chi_sim` 的内置配置声明 `chi_sim_vert`；该竖排模型和 `eng` 没有进一步子语言依赖。宿主 `chi_sim`/`eng` 仍独立检查，未把固定模型的依赖要求硬编码到宿主模型。最终解析器的独立实文件测试已覆盖以上五份文件。

## 实验约束

沿用前轮 32 张 PNG × 5 种固定策略，共 160 次真实 Seatbelt 识别，Tesseract 5.5.3、`chi_sim+eng`、OEM 1。生成器、原图 SHA-256、每种处理后输入 SHA-256 和 PSM 均与旧报告核对。只补充已声明的依赖文件及其精确读取权限；未关闭模型配置、增加命令行语言、改变裁切/去线算法或采用按样本择优策略。

新报告保留前轮报告的 SHA-256、模型仓库/提交、三个模型的版本哈希、生成器及实验/组件构造代码哈希。逐行记录去空白后的旧文本是否复现，并分别计算相对前轮同策略的严格金额改善/退化、币种宽度等价改善/退化。`baselineReproduced` 仅比较原图与最初固定模型报告；它是依赖改变后的观测值，不再作为“依赖改变不允许影响文本”的断言。最终严格金额门槛保持原来的至少一种固定预处理 32/32 命中要求。

## 完整结果

[完整机器可读报告](ocr-quality/2026-09-10-preprocessing-complete-dependencies.json) 已保留。160 次进程全部退出 0，逐次暂存输入哈希与 work 无遗留检查通过。最终严格质量断言失败，测试退出码 101。测试整体 478.87 秒，报告记录到写出前为 478.447 秒；包含生成、组件准备、复核和进程启动，期间也运行过普通回归/构建，不能据此比较识别速度。

| 固定策略 | 严格金额命中 | 币种宽度等价命中 | 相对前轮同策略严格改善 / 退化 | 相对前轮同策略宽度等价改善 / 退化 |
|---|---:|---:|---:|---:|
| 原图 PSM 3 | 8/32 | 14/32 | 0 / 0 | 0 / 0 |
| 只重新编码 PSM 3 | 8/32 | 14/32 | 0 / 0 | 0 / 0 |
| 去线 PSM 3 | 9/32 | 14/32 | 0 / 0 | 0 / 0 |
| 去线后已知金额行裁切 PSM 3 | 9/32 | 14/32 | 0 / 0 | 0 / 0 |
| 同一裁切图 PSM 7 | 9/32 | 14/32 | 0 / 0 | 0 / 0 |

160 份原始文本逐字一致，不仅是去空白后复现；32 份原图也复现最初固定模型基线。原图、重新编码和去线三组完整图的控制短句各为 96/96 命中；裁切组不评估画面之外的短句。前轮多识别一个前导零的退化依然存在。

加载诊断有明确变化：前轮 160 次均有 `chi_sim_vert` 加载失败，本轮全部消失。128 次仍有 `Estimating resolution as ...`，PSM 7 的 32 次 stderr 为空；没有屏蔽诊断或关闭通用准确性告警。这里的变化证明已修复本次缺失依赖路径，不能把非空 stderr 统一解释为加载失败，也不能把 stderr 为空解释为金额准确。

结论：在这 32 张图与五种策略中，补齐子语言未改变文本，不能将此前横排金额误读归因于这个缺失依赖。下一步可在完整模型依赖和保留的严格基线上评估其他引擎，并扩展金额数值、字号及真实扫描；当前样本不支持继续把同一套去线/裁切设为默认。组件发布签名、公证、安装激活和完整桌面验收仍待完成，生产 OCR 保持关闭。

## 工程验证

最终代码的全量 Rust 库测试 147 通过、13 忽略；此前沙箱模块普通测试 53 通过。新增覆盖容器偏移/截断、无 config、配置预算、路径/排除/重复/空白歧义、递归缺失、循环去重、来源输出、未登记模型和模型篡改。已重新生成非生产签名包夹具，完整安装准备链路继续通过。

最终配置格式收紧后，另行用真实宿主两模型及固定三模型运行 `inspect_complete_development_model_dependencies` 通过；该收紧不更改模型、图片或识别参数，没有因此重复 160 次矩阵。最终应用离线构建通过，保留既有 dead_code 警告；`rustfmt --check` 与 `git diff --check` 通过。报告的旧报告/实验/构造器/生成器哈希、三个模型哈希、160 项输入与评分、全文一致性和汇总均另行检查通过。未重跑监督故障矩阵、PDF/JPEG 质量集或桌面流程，不将本轮记为完整产品验收。

## 复现

后续已完成 [Apple Vision 候选评估](ocr-vision-evaluation.md)：同一批 PNG 的宿主严格金额命中 25/32，但现有 Seatbelt 中三个输入入口均在框架初始化时失败。质量改善与隔离阻断分别记录，未替换本页固定模型基线或启用产品降级执行。

三个模型放在同一个明确指定的开发目录中。报告路径必须是尚不存在的绝对路径，旧报告不覆盖。

```sh
cargo build --offline --manifest-path src-tauri/Cargo.toml --bin solidify
SOLIDIFY_TEST_BEST_TESSDATA=/absolute/path/to/pinned-models cargo test --offline --manifest-path src-tauri/Cargo.toml --lib inspect_complete_development_model_dependencies -- --ignored --nocapture
SOLIDIFY_TEST_BEST_TESSDATA=/absolute/path/to/pinned-models SOLIDIFY_TEST_OCR_REPORT=/absolute/path/to/new-report.json cargo test --offline --manifest-path src-tauri/Cargo.toml --lib live_chinese_ocr_complete_model_preprocessing_matrix -- --ignored --nocapture
```

真实隔离对照须在支持 Seatbelt 的外层执行。每个进程 wall 60 秒、CPU 30 秒、输出 64 KiB；整轮转换检查沿用 600 秒预算，生成和组件准备不由此回调强制中断。
