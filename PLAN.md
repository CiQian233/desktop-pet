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
| 原生分辨率 | **76 × 68 px**（初版 44×42 的约 2.5 倍细节预算，含边缘安全边距） |
| 动画 | **7 组 / 33 帧**：sit(4) blink(6) walk(6) sleep(4) pat(5) carry(6) angry(2) |
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

## 2. 当前技术架构（v0.3.2）

```
desktop-pet/
├─ src/
│  ├─ main/
│  │  ├─ main.ts            生命周期、透明小窗、托盘、显示器、电源与 IPC
│  │  ├─ config.ts          Electron 配置路径、运行时 Store 与防抖
│  │  ├─ config-core.ts     配置校验、版本迁移、原子保存、备份与损坏恢复
│  │  └─ preload.ts         contextBridge 最小能力桥
│  ├─ renderer/
│  │  ├─ renderer.ts        帧循环、手势、绘制、轮廓和性能探针
│  │  └─ core/              帧加载、动画时钟、行为/物理、像素遮罩
├─ art/sprites/chibi-hd/    原生像素帧与来源图
├─ scripts/                 构建、单元测试、行为矩阵、打包
└─ docs/                    项目日志、版本更新与签名说明
```

### 关键窗口与渲染约束

```ts
new BrowserWindow({
  transparent: true, frame: false, resizable: false, skipTaskbar: true,
  alwaysOnTop: true, hasShadow: false, focusable: false,
  webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
});
// Windows 原生透明区域穿透；失败时恢复完整窗口，不启用全局忽略鼠标。
win.setShape(rectangles);
// 主/渲染统一使用内容区 DIP 坐标，位置报告携带递增 seq。
win.setContentBounds(bounds);
win.getContentBounds();
```

- **小窗跟猫**：窗口仅比当前倍率的猫咪略大，不使用整屏透明覆盖层。
- **位置一致性**：过期原生位置回传直接丢弃，渲染器按最新目标内容区绘制，避免高 DPI 下双影和残底。
- **像素完整性**：运行时使用 76×68 原生帧，目标矩形取整到物理像素；所有帧在最终栅格上生成单层、四连通的统一深黑外轮廓，八邻域补齐斜角，仅描外部背景且不在内部空隙加点，保留内部毛色与胡须。恒等变换下按完整 backing store 清帧，主画布与蒙版统一 CPU 光栅化；双姿态专项要求真实画布与同步干净副本逐像素一致。
- **多显示器**：支持自动/固定显示器，工作区变化时重新夹取；漫游保持单工作区，跟随与拖拽按指针切屏。
- **低打扰**：隐藏、锁屏和休眠停帧；电池省电时运动目标 30Hz，正常目标 60Hz。
- **配置可靠性**：`configVersion` 迁移、原子保存、已知良好备份、损坏文件留证和有限渲染恢复。
- **后续插件架构**：第 3 节仍是规划，不代表当前版本已实现外部插件宿主。

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
- [x] **选定 chibi**，按参考图提升到 76×68 高密度（保留边缘安全边距）
- [x] 走路 6 帧交替抬腿落爪；尾巴 9 段锥形 + 正弦摆动
- [x] `rest` / `roam` 两种行为模式（+ `follow` 附加）
- [x] 7 组 33 帧动画导出 + `meta.json` 动画时序单一来源

### M2 · 能跑起来的桌宠（可执行 exe）✅ 已完成并持续维护
- [x] Electron 骨架：透明置顶小窗、原生轮廓穿透、托盘、单实例、设置持久化
- [x] 渲染器读 `sprites/pet.json` 播动画，`image-rendering: pixelated` 整数倍放大
- [x] **暂停 / 继续**：托盘 + 右键菜单（冻结动画与移动，不加暗色遮罩或角标，状态持久化）
- [x] **倍率切换**：默认 3×，可选 2× / 3× / 4× / 6×
- [x] 实现 `rest` / `roam` / `follow` 三模式与切换
- [x] 物理：拖拽跟手、松手落体、落地压扁回弹、工作区边界约束
- [x] 基础互动：单击摸头、拖拽携带、双击生气、暂停时仍可右键
- [x] v0.3.2 完善内容区定位、多显示器、低打扰、配置恢复和渲染性能
- [x] **v0.3.2 双产物已构建并验收**：便携版完整矩阵 31/31；安装包通过静默安装、冒烟和卸载；SHA-256 与 blockmap 已生成
- [x] 开机自启开关（默认关，托盘可开）
- [x] 自动化验证：源码检查、4 项配置单测、冒烟与 31 项行为矩阵（含坐姿/携带双姿态真实画布像素检查）

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
2. ~~默认显示倍率~~ → 已定 **3×（228×204 CSS px）**；2× 更小巧，4× / 6× 更大。
3. ~~只在原地 or 到处走~~ → **两种都做，程序内可切换**
4. **要不要交互打扰**：默认完全不主动弹窗，还是允许番茄钟/提醒类插件主动出声？
5. **exe 形态**：便携版单文件（推荐，双击即用）还是安装包（带开始菜单/开机自启）。

---

## 6. 风险与对策

| 风险 | 对策 |
| --- | --- |
| Electron 包体 ~150MB | 便携版 + `asar` + 去掉 devDependencies；介意体积可随时换 Tauri（形象与插件层几乎不用改） |
| 透明窗口在部分显卡驱动下闪烁 | 内容区坐标 + 位置序号、透明背景、原生形状与真实拖拽回归；保留问题复现截图和日志 |
| 全屏游戏时置顶干扰 | 当前提供手动隐藏、锁屏/休眠停帧；全屏应用自动隐藏仍是后续可选项，未宣称已实现 |
| 插件质量参差 | 沙箱 + 权限声明 + 崩溃自动禁用，绝不影响主程序 |
