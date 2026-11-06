# 静态预览 · dsh-provider-badge

设计预览，**不是运行时资源**。

- `capsule-dark.png` — 深色主题下的效果图：灰色第三方供应商徽章 + 官方供应商（仅文字亮蓝 `rgb(79, 140, 255)`）。
- `capsule-light.png` — 浅色主题对照图。

真实插件通过 `conversation.input.right` 插槽挂载，布局与预览一致（12px gap，徽章 `margin-right:-6px` 收成 6px 视觉间距）；
高度默认 32px，可用 `--dsh-provider-badge-height` 覆盖。预览页写死 32px。
