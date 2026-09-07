
审查完成。我核对了仓内引用文件和飞书开放平台的公开 API 资料，结论如下。

总体评价
方案整体可行，调用链（建文档 → 插 block → 挂 wiki）和仓内资源复用的判断都站得住。但有一处方向性遗漏和几处会在实现时立刻踩坑的技术错误，建议动工前修正。

重大问题

1. 漏掉了飞书原生 Markdown 转换 API（最重要）

文档花了整个第四节设计自写转换器、第七节估了 2~4 小时开发 + 单测，但飞书官方已有服务端转换接口：

POST /open-apis/docx/v1/documents/blocks/convert — 直接把 Markdown 文本转成 docx block 数组，权限点是 docx:document.block:convert（见 feishu-docs skill 的端点清单 和 agentica-gateway 的权限文档）。
POST /open-apis/drive/v1/import_tasks — 支持把 .md 文件直接导入为云文档（官方文档）。
第十节"备选方案对比"只列了浏览器导入和第三方工具，没列这两条 API 路径。自写转换器应该降级为兜底方案（比如转换 API 不支持的语法），而不是主路线。这一改动能让方案砍掉最大的一块工作量。

2. 嵌套结构插不进去：缺 descendant 接口

方案 B 的代码只用 blockChildren.create 一次插入全部 block，但 children 接口只能建一层。表格（table → table_cell → 单元格内 text）、嵌套列表、引用容器都必须用 POST /docx/v1/documents/{id}/blocks/{block_id}/descendant 创建。文档对 descendant API 只字未提，按现有写法表格和嵌套列表第一步就会失败。

3. 待办列表的判断错了

第 165 行说"飞书无原生抽屉 block，用 bullet 模拟"——实际上 block_type: 17 就是 todo block，原生支持 - [ ]。应直接映射。

细节错误
行内样式字段名不对（第 157 行）：实际是 text_run.text_element_style，不是 text_element.style；链接是 text_element_style.link.url（值需 URL encode），不存在 link.unseal_value 这个字段。
引用块：block_type: 34 是 quote_container（容器），子内容要作为它的 children 插入，文档没说明这一点。15 是旧版 quote，已废弃只读。
代码块语言：飞书是整数枚举（如 PlainText=1、Python=49 这类），不是字符串 "plain"，映射表要按整数落实。
SDK 方法名存疑（方案 B 代码）：client.docx.document.blockChildren.create 在 @larksuiteoapi/node-sdk v1 里应为 client.docx.documentBlockChildren.create（资源是扁平命名的），建议对着 node_modules 里的 SDK 类型确认。
权限表（第 53 行）：drive:file:upload 这个权限点名称需要核实，upload_all 实际需要的是 drive:drive；建议以控制台搜索到的实际权限点为准。
列知识库的顺序问题（第二节）：GET /wiki/v2/spaces 只返回应用已被加为成员的知识库，应用没加入时返回空列表，容易被误判为"没有知识库"。应把第八节风险表里的"先加成员"前置到第二节作为前置步骤。
耗时自相矛盾：开头说"首次接入约 3060 分钟"，但第七节的步骤加起来是 4.58 小时（光转换器就 2~4 小时）。开头那个数字大概只算了权限+跑通，建议改口或删掉。
回滚缺 API：验证清单要求"失败时回滚删除空文档"，但正文没提删除接口（DELETE /drive/v1/files/{token}?type=docx），补一句更完整。
核对无误的部分
block_type 枚举值 2/3-11/12/13/14/22/27/31/34 与公开资料一致；children 单批 50 上限正确。
图片走 drive/v1/medias/upload_all + parent_type=docx_image 正确，parent_node 必须是已建 docId 的顺序约束也对。
仓内引用全部属实：send-file.mjs（在仓库根目录，不在 src/）、src/fetchWithRetry.mjs、src/logger.mjs、scripts/report-progress.mjs、docs/飞书opencode桥-接入指南.md 都在；@larksuiteoapi/node-sdk ^1.72.0 已在 package.json；.env.example 确有 FEISHU_APP_ID/SECRET，进度端口 41235 也对。
wiki 节点 node_type: "origin" 挂载已有 docx 的用法正确。
建议
主路线改为：blocks/convert 转 Markdown → children/descendant 插入 → 挂 wiki，自写转换器只作为转换 API 覆盖不到时的补充。这样第七节可以砍掉第 3 步的大头，整体落到 1~2 小时内。

需要的话我可以直接按这些意见修订这份文档。
