# sologsb101-1013 珊瑚礁样带普查与白化分级台

面向礁区生态普查队的纯前端单页应用：外业队按站位布设样带、记录底质、珊瑚分类覆盖与鱼类计数；分级组独立持有白化等级与礁区结论。**两套账物理分表、互不覆盖**，现场断网照常记账，网络恢复后按样带编号对账，对不上的挂起等人定。数据全部保存在浏览器本地（IndexedDB），不依赖任何后端服务或外部接口。

## 〇、两账分离与对账规则（核心）

| 规则 | 实现 |
| --- | --- |
| 两边各持一份 | 外业账：`reefs / sites / belts / corals / fishes`；分级账：`assessments / beltGrades / reefConclusions`。外业界面不再有白化等级录入，分级工作台不写覆盖。 |
| 外业队管样带与珊瑚覆盖 | 珊瑚记录只存属名 / 形态 / 覆盖长度；`corals.bleachLevel` 仅为旧数据兼容字段，外业不可写。 |
| 分级组管白化等级与礁区结论 | 逐条等级拍快照进 `assessments`，样带定级进 `beltGrades`（未定级 / 已定级 / 待复核 / 有分歧），礁区上报结论进 `reefConclusions`。 |
| 现场断网照旧记账 | 外业每条增删改进本地发件箱 `outbox`（同一实体合并为一条），断网时只暂存不报错。 |
| 网络恢复按样带编号对账 | 顶栏网络开关拨回在线（或点「发送发件箱并对账」）即触发：以定级单记录的覆盖依据哈希（`utils/basis.ts`，只含样带属性与覆盖、不含等级）逐条核对。 |
| 对不上的等人定 | 覆盖变更加 `syncIssues` 挂账，在分级工作台「待人工裁定」里处理（按新覆盖重新定级 / 维持原等级）；样带或礁区被外业删除则挂分歧（删除分级账 / 留底备查）。 |
| 定过级的样带外业再改 → 待复核 | 哈希不一致且状态为「已定级」时自动转「待复核」，**分级账原等级原封不动**，外业页与覆盖页明确标注「不能上报」。 |
| 同步中断留外业重试 | 对账事务失败时发件箱保留、累计重试次数与失败原因，分级账一个字节不动；稍后自动 / 手动重试。工作台提供「模拟下次同步中断」开关演示。 |
| 旧数据升级补结论 | v2→v3 升级（或导入旧版备份）时，旧 `corals.bleachLevel` 整体迁入分级账，定级单状态置为已定级，并为每个礁区自动补一条「待复核」礁区结论。 |

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22813**

常用命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

> 宿主端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 22813）。
> 容器为纯静态 nginx，无数据库服务、不挂载任何命名卷，可随时删除重建。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3.5（Composition API + `<script setup>`） | 页面全部按路由懒加载 |
| 语言 | TypeScript 5.7（strict） | 构建脚本执行 `vue-tsc --noEmit` 类型检查 |
| UI 组件 | Element Plus 2.9 + @element-plus/icons-vue | 中文语言包，表格 / 表单 / 弹窗 / 徽标 |
| 构建 | Vite 6 | 产物 `dist/`，交给 nginx 托管 |
| 状态管理 | Pinia 2（setup store） | `reefStore` / `beltStore` / `surveyStore`（外业账）+ `gradingStore`（分级账）/ `syncStore`（发件箱与对账） |
| 路由 | Vue Router 4（history 模式） | 路径与提示词逐字一致，支持深链刷新 |
| 持久化 | Dexie 4（IndexedDB，库名 `gbcoralbelt`） | 结构版本 v3 + upgrade 迁移 + liveQuery 订阅 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/reefs` | 礁区台账 | Reef、Site、Belt、CoralRecord | 新建/编辑/删除礁区，按保护区状态与面积分档筛选，卡片汇总站位数、样带数与本礁区平均白化指数 |
| `/reefs/:id/sites` | 站位列表与水深标记 | Site、Reef、Belt | 新增/编辑/删除站位，经纬度校验（纬度 ±90、经度 ±180）并显示度分秒，按水深区间筛选，展开样带 |
| `/sites/:id/belts` | 样带布设 | Belt、Site、CoralRecord、FishCount | 布设样带（编号、长度、朝向、调查日期、调查人），回显已录记录数、覆盖率与白化指数，朝向排序校验 |
| `/belts/:id/corals` | 底质与珊瑚分类覆盖（外业） | CoralRecord、Belt | 按属名与形态录入覆盖长度与备注（**不录白化等级**），汇总覆盖率；等级列只读展示分级账；批量粘贴（忽略第 4 列旧等级） |
| `/belts/:id/fishes` | 鱼类与无脊椎动物计数 | FishCount、Belt | 按科名与体长段录入数量，按类别筛选与批量改类别，按科名和体长段汇总并折算密度（尾/100 m²） |
| `/coverage` | 外业覆盖度汇总 | 两套账 | 覆盖率 / 白化（分级账口径）按样带与礁区汇总、定级状态、结构版本、两套账 JSON 导入导出、清空重建演示数据 |
| `/grading` | 分级组工作台 | 分级账 + 发件箱 | 断网发件箱与在线 / 中断开关、按样带对账、待人工裁定、逐条白化定级（拍快照）、礁区结论撰写 |

带 `:id` 的层级路由在直接深链访问时同样可用：若 IndexedDB 中查不到该 id，页面渲染 `<RouteMissingPanel>` 友好空态（含返回入口与可用 id 快捷跳转），不会白屏。

## 四、目录结构

```
sologsb101-1013/
├── README.md
├── docker-compose.yml          # name: gbcoralbelt，不写 version
├── Dockerfile                  # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
├── nginx.conf                  # try_files $uri $uri/ /index.html; + gzip
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 前端独立构建用（同样多阶段 + chmod -R a+rX）
    ├── nginx.conf              # 前端独立托管用
    ├── .dockerignore
    ├── package.json            # build = vue-tsc --noEmit && vite build
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.ts             # 挂载 Pinia / Router / Element Plus，并打开并播种数据库
        ├── App.vue             # 顶部导航 + 上下文快捷入口 + 页脚数据概览
        ├── env.d.ts
        ├── types/              # reef / site / belt / coralRecord / fishCount / filter / grading
        ├── stores/             # reefStore / beltStore / surveyStore（外业）/ gradingStore（分级）/ syncStore（对账）
        ├── components/common/  # BleachTag / GradeStatusTag / FilterBar / StatBadge / EmptyPanel / RouteMissingPanel
        ├── hooks/              # useIdbTable
        ├── pages/              # ReefList / SiteList / BeltBoard / CoralEntry / FishEntry / CoverageView / GradingBoard
        ├── router/index.ts     # 路由表（路径与提示词逐字一致）
        ├── styles/main.css
        ├── scripts/            # smoke-e2e / smoke-upgrade（Node 冒烟，依赖 fake-indexeddb 用 --no-save 安装）
        └── utils/              # bleach.ts（算法）/ basis.ts（对账依据哈希）/ db.ts（两套表 + v3 迁移）/ export.ts（导入导出与结论）
```

## 五、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22813
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览构建产物
```

## 六、数据存储说明

- **存储位置**：浏览器 IndexedDB，库名 `gbcoralbelt`，当前结构版本 `v3`。读写统一经 `frontend/src/utils/db.ts` 封装，页面组件不直接触碰 Dexie 实例。
- **外业账表**：`reefs`（礁区）、`sites`（站位）、`belts`（样带）、`corals`（珊瑚覆盖；`bleachLevel` 仅旧数据兼容）、`fishes`（鱼类与无脊椎动物计数）。
- **分级账表**：`assessments`（逐条白化等级与覆盖快照，主键 = 珊瑚记录 id）、`beltGrades`（样带定级单：状态 / 等级 / 指数 / 依据哈希 / 定级人）、`reefConclusions`（礁区结论）。
- **本地对账表**：`outbox`（断网发件箱，按 `实体:id` 合并）、`syncIssues`（覆盖变更 / 样带删除 / 编号重复 / 礁区删除挂账）。这两张表是设备本地传输状态，不进备份快照。
- **升级迁移**：v1 初版；v2 补索引与必填字段；**v3 账套拆分**——`backfillGradingLedger()` 把旧 `corals.bleachLevel` 迁入 `assessments` + `beltGrades`，无覆盖样带保持「未定级」，并为每个礁区补结论（标注待分级组复核）。导入旧 v2 备份时走同一回填口径。调整字段结构时递增 `DB_VERSION` 并补迁移。
- **对账依据**：`utils/basis.ts` 对「样带属性 + 该样带全部珊瑚（id / 属名 / 形态 / 覆盖长度）」取 FNV-1a 哈希（与录入顺序无关、与白化等级无关）；定级时记下哈希，外业补记后哈希不一致即转待复核。
- **首屏播种**：`initDatabase()` 在 `reefs` 表为空时幂等播种演示数据（3 礁区 / 4 站位 / 5 样带 / 14 条珊瑚覆盖 / 12 条计数），并在同一事务回填分级账（覆盖无 / 轻 / 中 / 重 / 死亡全部等级），保证两个工作台打开即有内容。
- **实时同步**：`watchTable()` 基于 Dexie `liveQuery` 订阅表变化，Pinia store 自动刷新；顶栏在线开关 / `online` 事件 / 发件箱积压都会触发自动对账。
- **算法口径**：珊瑚覆盖率 = 覆盖长度合计 / 样带长度 × 100%（外业账）；白化指数 = 分级快照按覆盖长度加权平均（无 0 / 轻 1 / 中 2 / 重 3 / 死亡 4，0 ~ 4），指数换总体等级；鱼类密度 = 计数 /（样带长度 × 1 m）× 100（尾/100 m²）。**上报口径只认分级账**：未定级 / 待复核 / 有分歧的样带结论中明确标注「暂不能上报」。
- **备份与恢复**：`/coverage` 页导出含外业账 5 表 + 分级账 3 表的 JSON 快照（不含 outbox / syncIssues），支持覆盖导入与追加导入（id 重映射时分级账跟随外业 id）；备份时间写 `localStorage`。
- **冒烟测试**：`frontend/scripts/` 下 `smoke-e2e.ts`（断网 / 中断 / 待复核 / 裁定）与 `smoke-upgrade.ts`（v2→v3 迁移），用 esbuild 打包后 `node` 运行（`npm i --no-save fake-indexeddb`）。
- **离线可用**：应用为纯静态资源，无真实网络请求；断网是业务层语义（发件箱 + 手动开关模拟）。换浏览器或清空站点数据后数据不跟随，需通过 JSON 备份迁移。
