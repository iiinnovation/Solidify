---
name: demo-code
version: 2.1.0
displayName: 演示代码
description: 生成可直接运行的前端 Demo。需要客户演示界面、交互原型或单文件网页时使用。
icon: Play
placeholder: 描述要演示的功能场景和目标受众...
allowed-tools: [read_file, list_dir, write_file]
skip-confirmation: true
---

# 演示代码

第一步读取 `reference/legacy-guidance.md` 的完整代码与输出要求。生成完整的单文件 HTML，包含真实感数据、清晰的 CSS 变量、响应式布局和可操作交互。先确认目标受众和主流程，完成后写入 `03-交付物/` 并说明运行方式。

## 提交前自检

主流程必须可点击完成，按钮、筛选、弹窗和空状态不能只是装饰。使用真实感示例数据，检查 375px 与 1440px 宽度下无横向溢出、遮挡和文字截断。除非用户明确要求，不依赖外部服务；页面打开后不得出现控制台错误。
