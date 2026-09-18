# WG Companion

> **wg-web 配套客户端** — 导入配置，即可看到你的名字、被授权的网段与授权模式（白名单 · 黑名单 · 全代理）；一键开关隧道、自动更新配置，全程无需打开 WireGuard 官方程序。

<p align="center">
  <b>Windows</b> · <b>macOS</b> · <b>Android</b>
</p>

---

## 这是什么

[**wg-web**](https://github.com/496793028/wg-web) 是一个 WireGuard 权限管控平台：在网页上为每个用户精细授权目的地，然后下载对应的 `.conf`。

WG Companion 是它的**独立配套客户端**：

| 能力 | 说明 |
| --- | --- |
| 📇 **导入即识别** | 解析配置内嵌的 `wg-meta` 元数据（wg-web 自动生成），界面直接显示 **真实姓名 / 授权模式徽章 / 被授权网段**；老版本配置也能按注释与文件名兜底识别 |
| 🔌 **一键开关隧道** | 无需打开 WireGuard 图形程序：Windows 走官方 `wireguard.exe` 服务化接口（`WireGuardTunnel$` 系统服务，随系统自启），macOS 走 `wg-quick`，Android 内嵌 WireGuard 官方 GoBackend（系统 VPN 服务） |
| 🔐 **账号登录**（Windows / macOS / Android） | 「导入配置」右侧的**登录**按钮：用平台为本人开通的「VPN 账号」（用户名 = VPN 配置姓名 + 密码）登录，登录后**自动拉取你的配置并置顶显示**，退出登录即删除。支持**保存密码**（三端均用系统级安全存储加密：Windows DPAPI / macOS Keychain / Android Keystore，绝不落明文）、**自动登录**、**历史用户名下拉**（输入即筛选、无匹配自动消失、选中回填已保存密码、条目可删除并连同密码一起删除） |
| 🔄 **自动更新配置** | 监视已导入的 `.conf`：在 wg-web 重新下载并覆盖后**自动感知并生效**；隧道在线时自动断开重连下发新配置 |
| ✨ **优雅华丽的界面** | 与 wg-web 同源设计语言（淡紫 × 鎏金徽章）：启动/入场动画、点击涟漪、连接中的呼吸光晕、卡片列表交错入场、拖放导入遮罩、开关滑动动效；关闭确认与登录面板均为自绘华丽弹窗（按钮带悬浮/按压/光泽扫过动画）…… |

## 项目结构

```
wg-companion/
├── desktop/    # Electron 桌面端（Windows / macOS）
│   ├── main.js / preload.js / renderer/   # 应用
│   └── lib/core.js                        # 配置解析与平台命令（纯逻辑，带单测）
└── android/    # Android 工程（Kotlin + Compose + WireGuard 官方嵌入库）
```

## 快速开始

### Windows / macOS（桌面端）

```bash
cd desktop
npm install
npm start          # 开发运行
npm run dist       # 打包安装程序（Windows nsis / macOS dmg）
```

前置条件：

- **Windows**：安装 [WireGuard 官方 MSI](https://download.wireguard.com/windows-client/)（本应用调用其 `wireguard.exe /installtunnelservice` 服务化接口）。打包出的安装程序会请求管理员权限，隧道即以 `WireGuardTunnel$<隧道名>` 系统服务运行。
- **macOS**：`brew install wireguard-tools`（提供 `wg-quick`）。开启/关闭时系统会弹出管理员密码确认框，无需应用常驻 root。

> **macOS 预编译包**：按芯片选择 `WG Companion-<版本>-mac.zip`（Intel）或 `WG Companion-<版本>-arm64-mac.zip`（Apple 芯片），解压得到 `WG Companion.app`。包体**未做 Apple 签名与公证**，首次打开需绕过 Gatekeeper：
> 右键点 App → 「打开」→ 弹窗里再点一次「打开」；或终端执行
> `xattr -dr com.apple.quarantine "/Applications/WG Companion.app"`。
>
> 打包方式说明：electron-builder 有硬限制「Build for macOS is supported only on macOS」，无法在 Windows 上交叉打包，因此改用 **electron-packager**（`node build-mac2.js`，用 `MAC_ARCH=x64|arm64` 选架构）。脚本会做两件关键事 —— 用 `--asar` 打包，并在写 zip 时**按路径强制设置 0755 可执行位、原样保留符号链接**（Windows 文件系统没有 Unix exec 位，不处理的话 Mac 上解压出来的 Mach-O 没有执行权限，双击无反应）；打包后还会校验 Mach-O 魔数与 `app.asar`，不完整就直接失败，绝不产出「能下载但起不来」的包。

使用（两种方式任选）：

- **导入配置**：从 wg-web 用户卡片点击「客户端配置」下载 `.conf` → 拖入本应用（或点「导入配置」）→ 点开关。之后每次权限变更，只要重新下载同名配置覆盖，应用会自动更新并在隧道在线时自动重下发。
- **账号登录**（桌面端）：点「导入配置」右侧的**登录** → 填服务器地址 / 用户名 / 密码 → 登录成功后该账号的配置**自动拉取并置顶显示**（卡片带「账号配置」标识），并可勾选「保存密码」「自动登录」。退出登录会删除这些配置。

#### Windows 安装与卸载（分步安装器）

打包出的 `WG Companion Setup x.y.z.exe` 是一个**分步 NSIS 安装向导**（非一键安装），流程如下：

1. **选择安装目录**：默认 `C:\Program Files\WG Companion`，可手动更改（例如改到 `D:\Apps\WG Companion`）。
2. **选择快捷方式**（自定义页，紧随目录页之后）：桌面快捷方式 / 开始菜单快捷方式 —— **默认均勾选**，取消勾选则不创建。（静默安装同样会创建。）
3. 点「安装」→ 写入文件 → 完成页可勾选「运行 WG Companion」。

> 安装器以**每台机器（perMachine）+ 管理员**方式运行，会弹出 UAC 提权；这是因为隧道需注册为 `WireGuardTunnel$<隧道名>` 系统服务。若你不是管理员，请右键「以管理员身份运行」安装程序。

**卸载**（两种方式，任选其一）：

- 控制面板 → 程序和功能 → 找到 **WG Companion** → 卸载；
- 或直接运行安装目录下的 **`Uninstall WG Companion.exe`**。

> 卸载只移除程序文件，默认**保留**你的用户配置（已导入的 `.conf`、排序、关闭行为记忆等，位于 `%APPDATA%\io.github.wgweb.companion`）。需要彻底清理时，手动删除该目录即可。

### Android

用 Android Studio 打开 `android/` 目录，直接 Run：

- 内嵌官方库 `com.wireguard.android:tunnel`（GoBackend），首次开启隧道时系统会弹出 VPN 授权；
- 支持从文件管理器直接「用 WG Companion 打开」.conf；
- 界面与桌面端同款卡片：姓名、模式徽章、网段胶囊、滑动开关；
- **账号登录**：「导入配置」右侧「登录」→ 华丽登录卡片，登录后**自动拉取该账号的配置并置顶显示**（卡片带「账号配置」标识）；支持「保存密码」（**Android Keystore AES-256-GCM** 加密）、「自动登录」、「历史用户名下拉」（输入即筛选、无匹配自动消失、选中回填已保存密码、条目可删除并连同密码删除）；卡片内「退出登录」会删除该账号拉取的配置。

命令行构建（无需 Android Studio）：

```bash
node android/build-apk.js     # 产物 android/app/build/outputs/apk/debug/app-debug.apk
```

> 该脚本会直接调用 `org.gradle.launcher.GradleMain`（Gradle 8.7 + JDK 17）在线下缓存上构建；若首次构建报 daemon 日志「拒绝访问」，清空 `~/.gradle/daemon/8.7` 后重试即可。
> 服务端 HTTPS 为自签名证书时，Android 端会先按系统标准校验、失败后再按「允许自签名」重试一次（与桌面端 `allowInsecure` 默认开 的行为对齐）。

## wg-meta 元数据协议

wg-web 生成的 `.conf` 首行附带：

```
# wg-meta v1 <base64(utf8 json)>
```

其中 JSON 为：

```json
{ "v": 1, "name": "真实姓名", "mode": "allow|deny", "proxy": 0|1, "nets": ["10.100.0.0/24", "..."],
  "server": "https://vpn.example.com", "token": "<每账号只读令牌>", "id": 12 }
```

- `name` / `mode` / `proxy` / `nets` → 界面展示（姓名、模式徽章、网段胶囊）；
- `server` / `token` / `id` → **服务端自动更新**所需：客户端凭 `token` 定时向 `server` 拉取本账号最新 `.conf`；`token` 由平台惰性生成、可撤销，仅能读取本账号配置，**无需管理员会话**。
- 标准 WireGuard 客户端按注释忽略，**完全兼容**；
- WG Companion 解码后显示真实信息（中文姓名存于 base64，conf 仍保持纯 ASCII）。

## 相关项目

- **[wg-web](https://github.com/496793028/wg-web)** — WireGuard 权限管控平台（服务端/管理端）：网页授权、黑白名单、全代理模式、网关 nftables 下发。

> 在 wg-web 的 README 中也可以找到指向本项目的链接。

## License

MIT（本应用自身代码）。WireGuard® 版权归 Jason A. Donenfeld，相关组件遵循其原始许可（GPLv2 / LGPL-2.1）。
