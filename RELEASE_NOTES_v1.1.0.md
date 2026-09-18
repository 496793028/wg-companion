# WG Companion v1.1.0

wg-web 的配套 WireGuard 客户端：导入 `.conf` 即显示**姓名 / 授权模式（白名单 · 黑名单 · 全代理）/ 授权网段**，一键开关隧道，**新增服务端配置自动同步**，**无需打开 WireGuard 官方程序**。

> 1.1.0 是承载「服务端自动更新」能力的正式版本（对应已部署的服务端提交 `c8853c1`）。

## 更新内容（相比 v1.0.0）

- **服务端配置自动同步**：导入由新版本 wg-web 下发的 `.conf` 后，客户端按设定间隔自动从服务端拉取最新配置并应用；隧道在线时自动重新下发，无需手动重新下载。
- **设置面板**：「设置」中可开关自动更新、调整检查间隔（默认 30 秒，最小 10 秒）、允许自签名证书（用于内网 HTTPS）。
- **同步状态徽章**：配置卡片显示「同步中 / 已同步 / 同步失败」状态，便于排查。
- **免登录只读令牌**：wg-web 为每账号惰性生成只读令牌（可在管理端清除作废），客户端仅能拉取自身配置，无需管理员会话。
- 纯出站 HTTPS 轮询，**无需在客户端开放任何入站端口**。
- **界面版本号**：主窗口右下角常驻显示当前版本（如 `v1.1.0`）。
- **GitHub 更新检查**：启动后自动查询 `496793028/wg-companion` 的 Releases 最新版，发现更高版本时顶部弹出横幅提示「前往下载」（每整点复查一次）；点击即打开发布页。网络异常或接口限流时静默跳过，不影响使用。

## 下载

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows | `WG Companion Setup 1.1.0.exe` | 分步安装器（可选安装目录 + 可选桌面/开始菜单快捷方式 + 控制面板卸载） |
| Android | `app-debug.apk` | 侧载安装包（内嵌官方 WireGuard GoBackend）· 已更新至 v1.1.0：界面显示版本号 + 启动检查 GitHub 更新 |

## Windows

1. 运行 `WG Companion Setup 1.1.0.exe`（需**管理员权限**，隧道要注册为系统服务 `WireGuardTunnel$<隧道名>`）。
2. 安装向导：选择安装目录 → 勾选要创建的快捷方式 → 完成。
3. 从 wg-web 用户卡片下载 `.conf`，拖入应用或点「导入配置」即可开关隧道。
4. **服务端自动更新**（设置中默认开启）：由新版本 wg-web 下发的 `.conf` 会携带服务端地址与只读令牌，客户端据此按间隔自动从服务端拉取最新配置并生效；可在「设置」中调整检查间隔、关闭自动更新或允许自签名证书。

> ⚠️ 安装包**未代码签名**，Windows SmartScreen 会提示「未知发布者」，点「仍要运行」即可。

## Android

1. 允许「未知来源」安装后，点击 `app-debug.apk` 安装。
2. 首次开启隧道时系统会弹出 VPN 授权；从文件管理器「用 WG Companion 打开」`.conf` 也可直接导入。

> 注：本包为 debug 签名，便于分发测试；正式发布建议改为 release 签名包。Android 1.1.0 已同步加入「界面版本号」与「GitHub 更新检查」；服务端自动更新（wg-web 轮询）仍为 Windows / macOS 桌面端特性，Android 暂未包含。

> ℹ️ **Android 包已在本仓库重新生成并放入 `dist/`**：执行 `node android/build-apk.js`（沙箱内依赖 `.workbuddy/build/` 下的 JDK17 + Gradle 8.7 + SDK；本机则直接用 Android SDK 跑 `gradle assembleDebug`），产物 `android/app/build/outputs/apk/debug/app-debug.apk` 已复制到 `dist/app-debug.apk`。

> ⚠️ **服务端自动更新依赖新版本 wg-web**：需把 `VPN权限管控平台/server/server.js` 更新到含 `GET /api/client/conf?token=` 接口的提交（`c8853c1`），并停服后用 `--init` 加 `client_token` 列后重启。旧版 wg-web 下发的 `.conf` 不含自动更新信息，客户端不会自动拉取（重新下载一次即可）。

## 相关

- 服务端 / 管理端：[wg-web](https://github.com/496793028/wg-web)
