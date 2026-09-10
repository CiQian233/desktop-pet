# 桌面宠物 · 执行计划

> 形象基底：像素风三花猫（白底 + 橘黄 + 墨黑斑块，黄绿眼，粉鼻）
> 形象与配色由 `tools/` 下的 Python 生成器驱动，改参数即可出新动作
> 技术栈：Electron + TypeScript（已确认） · 插件形态：外部插件目录 + 热加载（已确认）
> 形象定稿：**chibi 高密度精修版**（已确认） · 行为模式：**原地待机 / 自由走动，可随时切换**（已确认）
> 显示倍率：默认 **3×**，程序内可选 **2× / 3× / 4× / 6×**（已确认）
> 交付物：**便携版 exe**（`dist/portable/`）+ **安装包**（`dist/installer/`）各一份（已确认）
> 交互：程序内可**暂停 / 继续**桌宠动作（已确认）

---

## 0. 已完成

### 0.1 形象（M1 已定稿）

| 项 | 值 |
| --- | --- |
| 原生分辨率 | **72 × 68 px**（初版 44×42 的 2.5 倍细节预算） |
| 动画 | **7 组 / 29 帧**：sit(4) blink(6) walk(6) sleep(4) pat(5) carry(2) angry(2) |
| 调色板 | 22 色：白毛 4 阶、姜色 4 阶、墨色 4 阶、虹膜 3 段、粉鼻/内耳、描边 |
| 眼 | 眼睑暗环 + 虹膜三段渐变 + 竖瞳 + 双点高光 + 反光 |
| 腿 | 两条分立前腿，内外侧分离阴影，脚爪带 3 道脚趾分隔 |
| 尾 | 9 段锥形曲线，按 `tail_swing` 正弦摆动（走路摆幅 ×7.5，待机缓慢摇尾） |
| 表情 | `mood`: neutral / sleepy（下眼睑抬起）/ angry（斜眉）· `dangle` 被拎起悬空 |

产出文件：

| 产出 | 路径 |
| --- | --- |
| 毛色提取 | `tools/extract_palette.py` → `art/palette/` |
| 主色板 | `tools/palette.py` |
| 像素绘制库 | `tools/pixel.py`（椭圆/三角/弧形/斑点/描边，可变形原语） |
| 高密度形象生成器 | `tools/chibi_hd.py`（`Params` 参数驱动全部动作） |
| 动画导出 | `tools/export_chibi_hd.py` → `art/sprites/chibi-hd/` + `preview/pet.json` |
| 迭代调试图 | `tools/iterate_chibi.py`（含去描边 debug 帧） |
| 交互预览页 | `preview/pet.html`（主）· `preview/index.html`（初版三方案对比，存档） |

### 0.2 行为模式（两种都做，程序内可切换）

| 模式 | 行为 |
| --- | --- |
| `rest` 原地待机 | 坐在固定位置：呼吸起伏、随机眨眼、缓慢摇尾；被摸头播 `pat`，被拖拽播 `carry` |
| `roam` 自由走动 | 沿屏幕在工作区来回散步，走到边界自动转身（水平镜像），走动时播 `walk` |
| （附加）`follow` 跟着鼠标 | 追着光标走，靠近后停下变回 `sit` |

---

## 1. 目标与原则

1. **形象优先**：形象已定稿，后续功能只做加法，不再改动形象比例。
2. **插件优先**：主程序只负责「窗口 + 渲染 + 状态 + 事件总线 + 插件宿主」，所有有趣功能都是插件。
3. **数据优先**：动作、台词、行为全部走配置/数据文件，改行为不改代码。
4. **低打扰**：默认安静待在屏幕角落；不做弹窗、不做强制提醒，一切都可关闭。

---

## 2. 技术架构（Electron + TypeScript）

```
desktop-pet/
├─ src/
│  ├─ main/                 主进程
│  │  ├─ index.ts           生命周期、单实例锁、开机自启
│  │  ├─ petWindow.ts       透明无边框置顶窗口 + 点击穿透 + 多屏边界
│  │  ├─ tray.ts            托盘菜单（显示/隐藏、插件管理、设置、退出）
│  │  ├─ store.ts           配置持久化（JSON，schema 校验 + 默认值合并）
│  │  └─ ipc.ts             主进程 ↔ 渲染进程通道白名单
│  ├─ renderer/             渲染进程（像素宠物的家）
│  │  ├─ engine/
│  │  │  ├─ spriteAtlas.ts  帧图集加载、按 scale 取帧
│  │  │  ├─ stateMachine.ts 状态机：idle/walk/sit/sleep/drag/fall/land
│  │  │  ├─ physics.ts      重力、落体、窗口边缘攀爬、拖拽惯性
│  │  │  ├─ bubble.ts       气泡对话（可被插件调用）
│  │  │  └─ screens.ts      屏幕枚举与工作区，用于跨屏漫游
│  │  └─ plugins/           插件宿主
│  │     ├─ host.ts         扫描 plugins/ 、沙箱加载、生命周期
│  │     ├─ api.ts          暴露给插件的 API 对象
│  │     └─ store.ts        每插件独立 KV 存储
│  ├─ shared/               类型定义、事件名常量、IPC 契约（主/渲染共用）
│  └─ plugins/              内置插件（随 exe 打包，可被外部插件覆盖）
├─ assets/sprites/<variant>/ 像素帧与图集
├─ data/                    台词包、行为权重、主题
└─ plugins/                 ★ 外部插件目录（用户/我随时丢新插件进来）
```

### 关键窗口参数

```ts
new BrowserWindow({
  transparent: true, frame: false, resizable: false, skipTaskbar: true,
  alwaysOnTop: true, hasShadow: false, focusable: false,
  webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
});
win.setIgnoreMouseEvents(true, { forward: true });  // 非宠物像素处点击直接穿透
```

- **点击穿透**：渲染进程上报宠物包围盒，只有落在像素上的鼠标事件才被接管；右键出菜单，左键摸头/拖拽。
- **性能**：窗口只占宠物大小（约 128×128），逐帧用 CSS `image-rendering: pixelated` 放大整数倍；空闲时降帧到 2fps，走动时 8fps。目标：空闲 CPU < 1%、内存 < 150MB。
- **省电**：全屏应用/游戏中自动隐藏（可选），笔记本电池模式下降帧。

---

## 3. 插件系统设计（重点）

### 3.1 插件形态

```
plugins/
└─ pomodoro/
   ├─ manifest.json      id / name / version / 入口 / 权限 / 配置项 schema
   ├─ index.js           入口（ESM，只在渲染进程的隔离上下文里跑）
   ├─ assets/            插件自带的像素图标
   └─ README.md
```

`manifest.json` 示例：

```json
{
  "id": "pomodoro",
  "name": "番茄钟",
  "version": "1.0.0",
  "entry": "index.js",
  "permissions": ["notify", "sound", "pet:say", "pet:animate", "storage"],
  "settings": [
    { "key": "focus", "type": "number", "label": "专注时长(分钟)", "default": 25 }
  ]
}
```

### 3.2 插件 API（给插件用的能力面）

```ts
export interface PetPluginApi {
  // 事件：主程序在关键时刻回调插件
  on(evt: 'tick' | 'click' | 'headpat' | 'feed' | 'dragStart' | 'dragEnd'
        | 'idleLong' | 'screenChange' | 'appFocus' | 'minute' | 'hour',
     cb: (payload?: any) => void): () => void;

  pet: {
    say(text: string, opts?: { ms?: number; mood?: string }): void;  // 气泡说话
    animate(name: string, times?: number): Promise<void>;            // 播放动作
    move(x: number, y: number, ms?: number): Promise<void>;          // 走到指定位置
    setMood(mood: 'happy' | 'hungry' | 'sleepy' | 'angry' | 'neutral'): void;
    scale(factor: number): void;
    bbox(): { x: number; y: number; w: number; h: number };
  };

  ui: {
    menu(items: MenuItem[]): () => void;        // 往托盘/右键菜单加条目
    panel(render: (root: HTMLElement) => void): () => void;  // 开一个像素风小面板
    badge(text: string): void;                  // 宠物头顶角标（如番茄钟倒计时）
  };

  sys: {
    notify(title: string, body: string): void;
    beep(kind?: 'ok' | 'warn' | 'error'): void;
    clipboardRead(): Promise<string>;
    clipboardWrite(text: string): Promise<void>;
    openExternal(url: string): void;
    exec(cmd: string): Promise<{ code: number; stdout: string }>;  // 需权限声明
  };

  store: { get<T>(key: string, fallback: T): T; set(key: string, v: any): void };

  assets: { url(relPath: string): string; pixels(relPath: string): Promise<string[][]> };
}
```

### 3.3 安全与稳定

- 插件跑在独立沙箱（iframe + `postMessage` 桥），**不直接接触 Node**；所有系统能力走白名单 IPC。
- `permissions` 未声明的能力调用直接拒绝，并在托盘里显示「插件 X 请求了 Y 权限」。
- 插件崩溃只影响自己：宿主捕获异常 → 禁用该插件 → 气泡提示「插件 X 出错了，已停用」。
- 热加载：`plugins/` 目录监听 `fs.watch`，新增/修改插件自动重载，**不用重打包 exe**。

---

## 4. 里程碑

### M1 · 形象定稿 ✅ 已完成
- [x] 照片取样色板 + 掩码核验
- [x] 3 款候选形象（chibi / real / retro）+ 交互预览
- [x] **选定 chibi**，按参考图提升到 72×68 高密度
- [x] 走路 6 帧交替抬腿落爪；尾巴 9 段锥形 + 正弦摆动
- [x] `rest` / `roam` 两种行为模式（+ `follow` 附加）
- [x] 7 组 29 帧动画导出 + `meta.json` 动画时序单一来源

### M2 · 能跑起来的桌宠（可执行 exe）✅ 已完成
- [x] Electron 骨架：整屏透明置顶覆盖窗口、点击穿透、托盘、单实例、设置持久化
- [x] 渲染器读 `sprites/pet.json` 播动画，`image-rendering: pixelated` 整数倍放大
- [x] **暂停 / 继续**：托盘 + 右键菜单（冻结动画与移动，暂停时有暗色遮罩 + 暂停角标，状态持久化）
- [x] **倍率切换**：默认 3×，可选 2× / 3× / 4× / 6×
- [x] 实现 `rest` / `roam` / `follow` 三模式与切换
- [x] 物理：拖拽跟手、松手落体、落地压扁回弹、屏幕边缘转身
- [x] 基础互动：摸头、拖拽（carry）、双击生气、暂停时仍可右键
- [x] **双产物**：`dist/portable/CalicoPet-portable-0.1.0.exe`（70.8 MB）
      + `dist/installer/CalicoPet-setup-0.1.0.exe`（77.9 MB）
- [x] 开机自启开关（默认关，托盘可开）
- [x] 自动化验证：`scripts/smoke.ps1` + `scripts/verify-behaviour.ps1`（7 用例全通过）

### M3 · 插件宿主 + 内置插件
- [ ] 插件宿主：扫描、manifest 校验、沙箱加载、权限、热重载、插件管理面板
- [ ] 内置示例插件（同时作为插件开发模板）：`hello-world`、`clock`
- [ ] 插件开发者文档 `docs/plugin-api.md`

### M4 · 功能插件铺开（按你点单，每个都是独立插件）
| 插件 | 说明 |
| --- | --- |
| 喂食 · 心情 | 饥饿/心情/精力数值，喂食动画、饿了会走到屏幕中间讨饭 |
| 番茄钟 | 专注 25min，期间猫在旁边睡觉，结束时叫醒你 |
| 久坐 / 喝水提醒 | 定时提醒，可设置免打扰时段 |
| 天气 | 拉免费天气 API，下雨天猫会说"记得带伞" |
| 音乐控制 | 读取/控制系统媒体播放，切歌时猫跟着摇尾巴 |
| 剪贴板小工 | 复制链接/文本时猫叼过来，点一下存进便签 |
| 桌面漫游 | 沿着窗口边缘走、趴在标题栏上打盹 |
| Git / 构建播报 | 提交成功猫开心，构建失败猫趴下 |
| 台词包 | 全部台词外置 JSON，可替换成你自己的话 |

### M5 · 打磨与分发
- [ ] 音效（轻量、可关）、多套皮肤（换色板即换猫）、节日彩蛋
- [ ] 自动更新（可选）、崩溃日志、使用说明

---

## 5. 待定（可以边做边定）

1. ~~形象选哪款~~ → 已定 **chibi 高密度精修版**
2. **默认显示倍率**：建议 3×（216×204）；2× 更小巧，4× 更大更清晰。
3. ~~只在原地 or 到处走~~ → **两种都做，程序内可切换**
4. **要不要交互打扰**：默认完全不主动弹窗，还是允许番茄钟/提醒类插件主动出声？
5. **exe 形态**：便携版单文件（推荐，双击即用）还是安装包（带开始菜单/开机自启）。

---

## 6. 风险与对策

| 风险 | 对策 |
| --- | --- |
| Electron 包体 ~150MB | 便携版 + `asar` + 去掉 devDependencies；介意体积可随时换 Tauri（形象与插件层几乎不用改） |
| 透明窗口在部分显卡驱动下闪烁 | 用 `transparent + hasShadow:false`，并提供「不透明底」降级开关 |
| 全屏游戏时置顶干扰 | 检测全屏窗口自动隐藏（M2 内置） |
| 插件质量参差 | 沙箱 + 权限声明 + 崩溃自动禁用，绝不影响主程序 |
