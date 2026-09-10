# 桌宠猫咪 · CalicoPet

以我家三花猫的照片为形象基底做的**像素风桌面宠物**。Windows 桌面上一只透明背景的像素猫，
不挡桌面操作（非猫身区域鼠标点击直接穿透），支持暂停/继续、倍率切换、三种行为模式，
后续功能以**插件**形式扩展。

> 计划与架构见 `PLAN.md`。

---

## 快速开始

```powershell
npm install          # 首次：装依赖（会自动下载 Electron 运行时）
npm start            # 编译 + 启动桌宠
```

打包出 exe：

```powershell
powershell -File scripts/pack.ps1                      # 便携版 + 安装包（推荐）
powershell -File scripts/pack.ps1 -Target portable     # 只打便携版
powershell -File scripts/pack.ps1 -Target installer    # 只打安装包

npm run pack:all                                       # 等价写法（内部就是调上面的脚本）
```

产物：

```
dist/portable/CalicoPet-portable-0.1.0.exe     便携版，双击即用，退出后自动清理临时目录
dist/installer/CalicoPet-setup-0.1.0.exe       安装包，可自选安装目录，建桌面/开始菜单快捷方式
```

> **必须用 `pack.ps1`**，不要直接调 `electron-builder`。
> electron-builder 解压 `winCodeSign` 辅助包时会碰到两个 Windows 建不出来的 macOS 符号链接，
> 7za 退出码 2 导致构建失败（尽管真正需要的 `rcedit` 已经解压好了）。
> `pack.ps1` 会临时替换 7za 剥离这两个条目，并在结束时还原。

> **签名**：产出的 exe 默认是 **NotSigned**，其他用户下载后会看到 SmartScreen
> 「未知发布者」警告。接入方式见 [`docs/CODE_SIGNING.md`](docs/CODE_SIGNING.md)——
> 配好环境变量（证书文件或 Azure Trusted Signing）后 `pack.ps1` 会自动签名，
> 没有证书时照常产出未签名产物，不会报错。

验证构建（无需人眼看屏幕，自动启动→自检→退出）：

```powershell
powershell -File scripts/smoke.ps1                          # 验证开发构建
powershell -File scripts/smoke.ps1 -Exe dist\portable\xxx.exe  # 验证打包产物
```

---

## 用法

| 操作 | 效果 |
| --- | --- |
| 左键点猫 | 摸头（`pat` 反应） |
| 双击猫 | 生气（`angry`） |
| 按住拖动 | 拎起来（`carry`），松手会落下并落地压扁 |
| 右键（任意处） | 打开菜单 |
| 托盘图标左键 | 摸头 |
| 托盘图标右键 | 菜单 |

菜单里可以：**暂停/继续动作**、切**行为模式**、切**显示倍率**、开机自启、窗口置顶、回到右下角、退出。

| 行为模式 | 说明 |
| --- | --- |
| 原地待机 | 待在原地，呼吸、眨眼、摇尾，久了会打盹 |
| 自由走动 | 沿屏幕来回散步，碰到边缘转身 |
| 跟着鼠标 | 跟着光标走，鼠标静止一会儿后停下休息 |

| 显示倍率 | 实际大小（原生 76×68） |
| --- | --- |
| 2× | 152 × 136 |
| **3×（默认）** | **228 × 204** |
| 4× | 304 × 272 |
| 6× | 456 × 408 |

设置会自动保存到 `%APPDATA%\CalicoPet\pet-config.json`，重启后保留位置、倍率、模式与暂停状态。

---

## 目录结构

```
desktop-pet/
├─ src/
│  ├─ main/          主进程：窗口、托盘、菜单、点击穿透、配置持久化
│  │  ├─ main.ts         透明全屏覆盖窗口 + 托盘 + 菜单 + 光标轮询
│  │  ├─ config.ts       配置读写（原子写入 + 字段校验）
│  │  └─ preload.ts      contextBridge 安全桥
│  ├─ renderer/      渲染进程：像素动画 + 物理 + 交互
│  │  ├─ renderer.ts     主循环、输入、绘制、暂停遮罩
│  │  ├─ config-types.ts 与主进程共用的配置契约
│  │  └─ core/
│  │     ├─ atlas.ts       帧加载
│  │     ├─ animator.ts    动画时钟（基础动画 + 一次性反应）
│  │     └─ controller.ts  位置/速度/重力/行为模式
│  └─ shared/layout.ts  窗口布局契约与 IPC 频道名
├─ art/sprites/chibi-hd/  像素帧（生成物，勿手改）
├─ tools/                 形象生成器（Python）
├─ preview/               形象预览页
├─ docs/CODE_SIGNING.md   代码签名接入说明
├─ scripts/               构建辅助（打包、资源同步、ESM 修正、冒烟测试）
│  └─ pack.ps1            打包入口（内含 7za 符号链接规避）
├─ .github/workflows/     CI：打 tag 自动构建 + 签名 + 发布 Release
├─ electron-builder.config.cjs  在 package.json 的 build 之上叠加签名
└─ dist/                  构建产物（不入库）
   ├─ portable/           便携版 exe
   ├─ installer/          安装包
   └─ smoke/              冒烟测试日志
```

---

## 改形象（像素猫）

形象由 `tools/chibi_hd.py` 里的 `Params` 参数驱动，**改数字就能出新动作**：

| 参数 | 作用 |
| --- | --- |
| `breath` | 呼吸起伏 |
| `blink` | 0 睁眼 / 1 半闭 / 2 闭眼 |
| `look` | 眼球左右偏移 |
| `gait` | 步态：-1 / 0 / +1，驱动两条前腿交替抬起 |
| `squash` | 压扁（坐下、落地） |
| `tail_swing` | 尾巴正弦摆动 |
| `mood` | `neutral` / `sleepy` / `angry` |
| `dangle` | 被拎起悬空 |

改完重新导出（会同时更新预览页与程序用的数据）：

```powershell
python tools/export_chibi_hd.py
npm run build          # 把新帧同步进 dist
```

加新动画：在 `tools/export_chibi_hd.py` 的 `ANIMS` 里加一条（名称 / 中文标签 / fps / 是否循环 / 参数列表），
**不需要改任何渲染代码**。渲染器只认 `pet.json` 里的动画名。

调试形象：

```powershell
python tools/iterate_chibi.py 6    # 导出全部姿态 + 去描边的几何调试图
python tools/make_icons.py         # 重新生成程序图标与托盘图标
```

---

## 插件（规划中，见 PLAN.md §3）

每个功能一个文件夹放在 `plugins/`：

```
plugins/pomodoro/
├─ manifest.json     id / 名称 / 版本 / 入口 / 权限 / 配置项
├─ index.js          入口（沙箱内运行）
└─ assets/           插件自带像素素材
```

插件宿主在 M3 里程碑实现；届时丢进目录即生效，**不需要重新打包 exe**。

---

## 分析录像类工具

`tools/` 下基于屏幕录像做动作分析的工具（`analyse_video.py`、`filmstrip.py`、
`frames_video.py`、`track_motion.py`、`track_pet.py`、`zoom_video.py`）不内置录像路径，
用环境变量或命令行参数传入：

```powershell
$env:PET_VIDEO = "D:\record\pet.mp4"
python tools/track_pet.py
# 或
python tools/track_pet.py D:\record\pet.mp4
```

输出统一写到 `dist/smoke/`（仓库相对路径，非硬编码盘符）。

---

## 常见问题

**打包失败 / 下载 Electron 很慢**
项目内 `.npmrc` 已配置国内镜像与项目内缓存目录（`.npm-cache`、`.electron-cache`、`.builder-cache`），
若用户级缓存被安全软件锁死，这些设置能绕开。必要时手动指定镜像：

```powershell
$env:ELECTRON_MIRROR = 'https://registry.npmmirror.com/-/binary/electron/'
```

**程序启动了但看不到猫**
猫默认在**主屏右下角**。托盘图标右键 → 「回到右下角」或「移到主显示器」。
若处于暂停状态，猫身上会盖一层暗色并显示暂停角标。

**点不动猫**
只有猫身像素接收鼠标事件，其余区域是穿透的 —— 这是刻意的设计。请点猫的身体。

**想看运行日志**
```powershell
$env:PET_LOG = "$PWD\pet.log"; npm start
```
`PET_DEVTOOLS=1` 还会打开开发者工具。
