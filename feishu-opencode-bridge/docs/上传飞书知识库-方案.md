# Markdown → 飞书知识库：API 转换上传方案

> 目标：本地用 Markdown 写文档,通过飞书开放平台 API 转换为 docx block 结构,上传到指定知识库节点。
> 基础：复用本仓 `feishu-opencode-bridge` 已持有的飞书自建应用(`FEISHU_APP_ID`/`FEISHU_APP_SECRET`)和 `@larksuiteoapi/node-sdk` 依赖,无需新建应用。
> 预计耗时：首次接入约 30~60 分钟(权限审批 + 转换器调试)。

---

## 一、方案总览

```
本地 .md 文件
   │
   ├─► Markdown Parser (remark / markdown-it)
   │     └─► AST 节点流 (heading / paragraph / list / code / table / image)
   │
   ├─► Block Transformer (自写映射层)
   │     └─► 飞书 docx Block 数组 (page / text / heading1-9 / bullet / ordered
   │           / code / quote / divider / table / image)
   │
   ├─► 图片素材预上传 (drive/v1/medias/upload_all → file_token)
   │
   ├─► 创建空文档 (docx/v1/documents)
   │
   ├─► 批量插入子 block (docx/v1/documents/{id}/blocks/{block_id}/children)
   │
   └─► 加入知识库节点 (wiki/v2/spaces/{space_id}/nodes)
         │
         └─► 返回 wiki node token + doc_url
```

> ⚠️ **关键差异**:飞书 docx 的 block 模型与 Markdown 不是 1:1。常见陷阱:
> - 嵌套列表飞书用 `parent_id` 树状结构,Markdown 用缩进
> - 代码块语言字段飞书是枚举,Markdown 是任意字符串(需做映射或丢弃)
> - 表格单元格在飞书里是独立 block,不是 markdown 的 `| a | b |` 行
> - 图片必须先上传素材拿 `file_token`,不能直接嵌 URL(外链图片会失联)

---

## 二、前置准备

### 1. 飞书应用权限补充

`feishu-opencode-bridge` 现有应用权限只开了 `im:message` 系列。上传知识库需补开以下权限(应用详情 → 权限管理 → 搜索开通 → 重新发布版本):

| 权限 | 用途 |
| --- | --- |
| `docx:document` | 创建、读取、编辑 docx 文档 |
| `docx:document:readonly` | 只读(可选,排查问题时用) |
| `wiki:wiki` | 知识库节点增删改查、加入文档 |
| `wiki:wiki:readonly` | 知识库只读(找 space_id 时用) |
| `drive:drive` | 上传图片素材、文件管理 |
| `drive:file:upload` | `upload_all` / `upload_prepare` 接口前置 |

### 2. 找到目标知识库参数

```bash
# 列出当前应用可见的知识库空间 → 拿 space_id
curl -X GET "https://open.feishu.cn/open-apis/wiki/v2/spaces?page_size=50" \
  -H "Authorization: Bearer ${TENANT_ACCESS_TOKEN}"
```

拿到 `space_id` 后,需要知道挂载位置的 `parent_node_token`(根节点留空表示挂到空间根)。可用 `GET /wiki/v2/spaces/{space_id}/nodes` 列节点树。

### 3. 把这两个值写进 `.env`

```bash
FEISHU_WIKI_SPACE_ID=xxxxxxxxxxxx
FEISHU_WIKI_PARENT_NODE_TOKEN=   # 留空=挂到知识库根节点
```

---

## 三、核心 API 调用链

### 1. 获取 tenant_access_token

复用 `@larksuiteoapi/node-sdk` 自动管理,无需手动刷 token:

```js
import lark from "@larksuiteoapi/node-sdk";

const client = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  appType: lark.AppType.SelfBuild,
  // SDK 自动在后台维护 token,无需手动 fetch
});
```

### 2. 创建空文档

```
POST /open-apis/docx/v1/documents
Body: { "folder_token": "" }   # 空串=默认文件夹,知识库挂载时会被移动
```

SDK 写法:

```js
const { data } = await client.docx.document.create({
  data: { folder_token: "" },
});
const docId = data.document.document_id;
```

### 3. 上传图片素材(如有)

```
POST /open-apis/drive/v1/medias/upload_all
multipart: file_type=png, file_name=xxx.png, parent_type=docx_image, parent_node=<docId>
```

返回 `file_token`,插入图片 block 时引用。注意 `parent_node` 必须是已创建的 docId,所以图片上传要在文档创建之后、block 插入之前。

### 4. 批量插入 block(核心)

```
POST /open-apis/docx/v1/documents/{document_id}/blocks/{block_id}/children
Body: { "children": [...blocks], "index": 0 }
```

- `block_id` = 文档根 block 的 id(创建文档时返回的 `document_id` 即根)
- `children` = 转换器输出的 block 数组
- 单次最多 50 个 block,超出需分批(同一接口 index 递增)

### 5. 加入知识库节点

```
POST /open-apis/wiki/v2/spaces/{space_id}/nodes
Body: {
  "obj_type": "docx",
  "obj_token": "<docId>",
  "parent_node_token": "<可选,空=空间根>",
  "node_type": "origin",
  "title": "<文档标题>"
}
```

挂载成功后,文档从默认文件夹移动到知识库,返回 `node_token` 和访问 URL。

---

## 四、Markdown → Block 转换映射

| Markdown AST 节点 | 飞书 docx block type | 备注 |
| --- | --- | --- |
| `heading` (depth=1) | `block_type: 3` (headings 1-9 对应 3-11) | depth 限制 1-9 |
| `paragraph` | `block_type: 2` (text) | children 是 text_run 数组 |
| `bulletList` | 每项 `block_type: 12` (bullet) | 嵌套用 `parent_id` |
| `orderedList` | 每项 `block_type: 13` (ordered) | 同上 |
| `code` | `block_type: 14` (code) | `style.language` 是枚举,未知语言用 `plain` |
| `blockquote` | `block_type: 2` + 折叠样式 或 `block_type: 34` (quote) | 推荐用 34 |
| `thematicBreak` | `block_type: 22` (divider) | — |
| `table` | `block_type: 31` (table) + 子 cell blocks | 单元格是独立 block |
| `image` | `block_type: 27` (image) | 需先上传素材拿 `token` |
| `link` (行内) | `text_run.text_element.style.link` | URL 写进 `link.unseal_value` |
| `strong` / `em` | `text_run.text_element.style` 的 `bold` / `italic` | — |
| `inlineCode` | `text_element.style.inline_code` | — |
| HTML 标签 | ❌ 不支持 | 需先转 markdown 或丢弃 |

### 不支持的 Markdown 特性(需降级)

- HTML 块 / 行内 HTML → 丢弃或转纯文本
- 任务列表 `- [ ]` → 飞书无原生抽屉 block,用 bullet + 文本 `[ ]` / `[x]` 模拟
- 脚注 / 定义列表 → 转 paragraph
- 数学公式 → 飞书有 `block_type: 46` (equation),但语法是 LaTeX 子集,需测试
- Mermaid / 流程图代码块 → 保留为 code block 或预渲染成图片上传

---

## 五、落地实现

### 方案 A:基于现有桥加新模块(推荐)

在 `feishu-opencode-bridge/src/` 下新增:

```
src/
├── mdToWiki.mjs           # 入口:CLI 主流程
├── mdToBlocks.mjs         # Markdown → Block 转换器(纯函数,可单测)
└── feishuWikiClient.mjs   # 飞书 docx/wiki API 封装
```

CLI 用法:

```bash
node src/mdToWiki.mjs <markdownFile.md> [--title "文档标题"] [--parent <nodeToken>]
```

复用现有桥的:
- `.env` 加载(已配 `FEISHU_APP_ID`/`SECRET`)
- `@larksuiteoapi/node-sdk` 依赖(已在 package.json)
- `logger.mjs` 结构化日志
- `fetchWithRetry.mjs` 重试(图片上传、block 插入容易偶发 429)

### 方案 B:独立脚本(快速验证)

参考仓内已有的 `send-file.mjs` 模式,写一个独立 mjs 脚本先跑通最小路径:

```js
import "dotenv/config";
import lark from "@larksuiteoapi/node-sdk";
import { readFileSync } from "node:fs";
import { remark } from "remark";
import { mdToBlocks } from "./mdToBlocks.mjs";

const md = readFileSync(process.argv[2], "utf8");
const ast = remark().parse(md);
const blocks = mdToBlocks(ast);

const client = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  appType: lark.AppType.SelfBuild,
});

const { data } = await client.docx.document.create({ data: { folder_token: "" } });
await client.docx.document.blockChildren.create({
  path: { document_id: data.document.document_id, block_id: data.document.document_id },
  data: { children: blocks, index: 0 },
});

const wiki = await client.wiki.spaceNode.create({
  path: { space_id: process.env.FEISHU_WIKI_SPACE_ID },
  data: {
    obj_type: "docx",
    obj_token: data.document.document_id,
    parent_node_token: process.env.FEISHU_WIKI_PARENT_NODE_TOKEN || "",
    node_type: "origin",
    title: process.argv[3] || "未命名文档",
  },
});

console.log("✅ 已上传:", `https://feishu.cn/wiki/${wiki.data.node.node_token}`);
```

### 方案 C:Markdown 仓库批量同步

写一个 `scripts/sync-md-to-wiki.mjs`,遍历目录所有 `.md`,根据 front-matter 的 `title` 和 `parent` 字段做树状挂载,记录 `path → node_token` 映射到 `data/wiki-sync-index.json`,支持增量同步(已存在的更新,不存在的创建)。

---

## 六、与现有桥的集成点

| 复用项 | 来源 | 用途 |
| --- | --- | --- |
| 飞书应用凭证 | `.env` 的 `FEISHU_APP_ID`/`SECRET` | 无需新建应用 |
| `@larksuiteoapi/node-sdk` | `package.json` 已装 | 调 docx/wiki/drive API |
| `fetchWithRetry.mjs` | `src/fetchWithRetry.mjs` | 图片上传、block 插入重试 |
| `logger.mjs` | `src/logger.mjs` | 上传过程日志 |
| `data/` 目录 | 已 gitignored | 存 `wiki-sync-index.json` |
| 进度推送 | `POST 127.0.0.1:41235/progress` | 批量上传时推飞书进度 |

**新增依赖**(仅 1 个):

```bash
npm install remark     # Markdown parser,纯函数,无副作用
```

---

## 七、落地步骤(推荐顺序)

1. **权限审批**(浏览器,5 分钟 + 等管理员)
   - 应用详情 → 权限管理 → 开通 `docx:document` / `wiki:wiki` / `drive:drive`
   - 版本管理 → 创建新版本 → 发布

2. **找 space_id**(命令行,1 分钟)
   - 用本文第二节的 curl 列出知识库,填进 `.env`

3. **写转换器**(开发,2~4 小时)
   - `mdToBlocks.mjs`:按第四节映射表实现,先支持 heading/paragraph/list/code/bullet,表格和图片后做
   - 单测覆盖 80% Markdown 语法

4. **跑通最小路径**(30 分钟)
   - 用方案 B 的独立脚本,上传一个简单 .md 到知识库根节点
   - 在飞书打开链接确认渲染正确

5. **补全图片上传**(1 小时)
   - 遍历 AST 中的 image 节点,本地路径读取 → upload_all → 替换为 image block

6. **封装 CLI + 批量同步**(1~2 小时)
   - 方案 A 入口 + 方案 C 索引文件

---

## 八、风险与限制

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 单文档 block 数上限 | 飞书限制约 5 万 block,长文档需分篇 | 转换器统计,超限按章节拆 |
| 嵌套列表层级 | 飞书支持但 API 构造 parent_id 树复杂 | 先支持 2 层,深层降级为扁平 |
| 图片外链失效 | 飞书不抓远程图,只认 `file_token` | 转换器下载外链图再上传,失败则跳过 |
| 代码块语言枚举 | 飞书只认枚举值,自定义语言变 `plain` | 维护 `mdLang → feishuLang` 映射表 |
| 知识库权限 | 应用必须是知识库成员或管理员 | 找知识库 owner 把应用加为成员 |
| 频控 | 上传大批 block 可能触发 429 | `fetchWithRetry` 指数退避,单批 ≤50 block |
| 重复上传 | 没有去重,同名文档会重复创建 | 维护 `data/wiki-sync-index.json` 做 path→token 映射 |
| 表格合并单元格 | 飞书 API 不支持跨列合并 | Markdown 本身无此特性,直接映射即可 |

---

## 九、验证清单

完成后的验收标准:

- [ ] `node src/mdToWiki.mjs test.md --title "测试"` 能输出飞书 wiki URL
- [ ] URL 在浏览器打开,标题、各级 heading、paragraph、列表、代码块渲染正确
- [ ] Markdown 中的本地图片在飞书里能正常显示
- [ ] 同名文档重复上传时,更新而非新建(基于 sync-index)
- [ ] 转换器单测覆盖:heading / paragraph / ul / ol / code / quote / divider / table / image / link / strong / em / inlineCode
- [ ] 权限不足时给出明确错误提示("应用未加入目标知识库,请联系 owner 添加为成员")
- [ ] 网络失败时重试 3 次后报错,不产生半成品文档(创建成功但 block 插入失败时回滚删除空文档)

---

## 十、备选方案对比

| 方案 | 优点 | 缺点 | 适用场景 |
| --- | --- | --- | --- |
| **本方案:API + 自写转换器** | 完全可控,可批量,可增量同步 | 转换器要自己维护 | 长期、批量、自动化 |
| 飞书"导入"功能(浏览器) | 零开发 | 必须手动、不支持 API 调用、富文本还原差 | 一次性、单文档 |
| 第三方工具 `lark-docx` | 现成转换器 | 维护停更、覆盖语法不全 | 快速验证 |
| 飞书 AI 助手生成 | 内容也由 AI 写 | 内容不可控、无法批量、无 Markdown 源 | 一次性草稿 |
| 用 `markdown-pdf` 转 PDF 再上传 | 还原度最高 | 不是可编辑的 docx,后续改要重传 | 归档类文档 |

**结论**:长期、批量、要可编辑的文档 → 本方案;一次性、不重要的 → 浏览器导入即可。

---

## 十一、参考

- 飞书开放平台 API:<https://open.feishu.cn/document/server-docs/docs/docs-overview>
- docx block 类型枚举:<https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document-block/list>
- 知识库 API:<https://open.feishu.cn/document/server-docs/docs/wiki-v2/space-node/create>
- 本仓现有桥接入指南:[飞书opencode桥-接入指南.md](./飞书opencode桥-接入指南.md)
- 现有飞书 SDK 用法参考:`send-file.mjs`、`scripts/report-progress.mjs`
