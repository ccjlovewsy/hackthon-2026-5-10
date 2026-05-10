AI 全栈极速黑客松 · AI 评审建议报告
你好，任锡清！

以下是你的中期 AI 评审建议。这份报告基于你当前提交的代码和文档自动生成，旨在帮助你在剩余时间内最大化提分。

请重点关注 "Top 5 改进优先级" 章节，按顺序执行性价比最高的改进。

AI 评审建议报告
选手： 任锡清
GitHub： https://github.com/HollowDobt/hackthon-2026-5-10
当前得分： 73/100（基础 50.5/62 · 进阶 18.5/28 · F 创新 4/10）

各维度得分
A. 文档完整性（5.5/15）
子项	基础分	进阶分	得分	扣分原因	改进建议（耗时 · 预计提分 · 类型）
README 可复现性	1.5/3	0/1	1.5	仓库根目录没有顶层 README.md，新人 clone 进来看不到入口；docs/README.md 实际是给 AI 用的早期开发提示词，里面甚至有"/Users/renxiqing/hackthon/"这种本地绝对路径，并不是产品 README	在仓库根目录新建 README.md：写清"项目简介、npm install && npm start、浏览器访问 http://127.0.0.1:3000/、依赖 Node ≥ 20、需在前端配置 LLM Endpoint+APIKey"四项（10 分钟 · +1.5 分 · 补基础分）
需求分析文档	0/3	0/1	0	仓库里没有 docs/需求分析.md 之类的文档；赛题要求的"知识点粒度、重复判定、教学连贯性、压缩比"四个子问题虽然代码里都有体现，但没有专门的需求分析文档说明	新建 docs/需求分析.md：四个小节分别写"知识点粒度（章节级提取，每章 ≤12 个）、重复判定（lexical+LLM 双判 + necessity 校验）、教学连贯性（四类关系 + 教师反馈接口）、压缩比（30% 目标，integrated/original 公式）"，每节 100-150 字（25 分钟 · +3 分 · 补基础分）
系统设计文档	1.5/3	1/1	2.5	docs/API.md（798 行）非常详尽，请求/响应示例齐全，足以拿 P1 的接口文档分；但缺少独立的"架构说明 + 数据流 + 技术选型"——这些信息散落在 API.md 头部小段里，没有体系化呈现	新建 docs/系统设计.md：写一张 mermaid 架构图（preParse → parseEntity → dedupAlign → RAG → 前端）+ 数据流（教材文件 → data/preParse...json → data/node
整合报告	1/2	0.5/1	1.5	report/整合报告.md 只有 17 行，且关键字段全是占位符（"整合后字数：待整合后生成"、"压缩比：待整合后生成"、"决策：0"、"重点案例：当前尚未产生"），实际跑过样例后没有回填；不过模板结构和"教学完整性说明"段落框架在	跑一次 npm run rag:sample + 至少一次完整去重流程后，把 data/NodesDeduplicationAndAlignment.latest.json 里的 stats.compression_ratio、decision_count、action_counts、raw_node_count → current_node_count 真实数字填回报告；再从 decisions.json 里挑 3 个最典型决策（merge/keep/remove 各一）作为"重点整合案例"展开（20 分钟 · +1.5 分 · 补基础分+冲进阶分）
B. 功能实现（21.5/25）
子项	基础分	进阶分	得分	扣分原因	改进建议（耗时 · 预计提分 · 类型）
多格式文件解析	2/2	1/1	3	PDF/MD/TXT/DOCX/XLSX/XLS/CSV/TSV 全支持，前端有 accept 列表，依赖 pdfjs-dist / mammoth / xlsx，错误处理在 frontend 上传链路里	—
知识点提取与图谱构建	4/4	1/1	5	LLM 抽取 + JSON schema + 4 种关系类型 + few-shot 示例（静息电位/动作电位/钠通道开放）+ 关系类型严格枚举校验（ALLOWED_RELATION_TYPES），P1 都满了；唯一可挑剔的是没有显式置信度分数（confidence），但章节级 source_quote 算等价证据	—
知识图谱交互	2/2	0/0	2	节点点击详情、滚轮缩放、画布拖拽、节点拖拽、频次→大小映射全部实现	—
跨教材整合算法	4/5	0.5/1	4.5	有 lexical（Dice 二元 n-gram）+ LLM 双判 + necessity 必要性校验 + 30% 压缩 target；P1 的"双重对齐"满足，但"整合前后可视化对比"只在数据层（buildComparison 返回 before/after node_count）有，前端没有 before/after 双视图切换（只有"源图/整合图"切换两个独立视图）	在前端 app.js 的"自动去重"面板加一个"整合对比"按钮：调用 /api/frontend/graph?scope=source 和 ?scope=integrated 两次，把节点数/关系数/压缩比放并排卡片展示，再加一段简短的"被合并节点列表"（30 分钟 · +0.5 分 · 冲进阶分）
RAG 问答功能	4/4	1/1	5	完整 pipeline（700 字 chunk + 80 字 overlap + text-embedding-3-small + Vectra 本地向量库 + 带引用生成）+ 混合检索（vector + BM25 + keyword fusion 加权）+ 引用自动校验/补齐（verifyAndRepairAnswerCitations），P1 满分；自建 benchmark 没看到，但混合检索已经够拿 bonus	—
多轮对话与迭代	2/3	1/1	3	对话接口在（memoryTab + data/NodesDeduplicationAndAlignment.conversation.json 持久化），教师反馈能实际触发整合决策并刷新图谱（P1 满），但"会话历史管理"略简陋——前端只展示最近 12 条，没有删除/清空操作；后端把 conversation 写到独立 JSON 但没有 sessionId 隔离	在 app.js 的 memoryTab 加一个"清空对话历史"按钮（调用一个新增的 DELETE /api/NodesDeduplicationAndAlignment/conversation），并在 conversation.json 里加个 created_at 字段（20 分钟 · +1 分 · 补基础分）
C. 可视化（11/13）
子项	基础分	进阶分	得分	扣分原因	改进建议（耗时 · 预计提分 · 类型）
视觉实现	3/3	2/2	5	Cytoscape 专业库 + 多维度叠加（节点大小=frequency、节点颜色=category、边框颜色=textbook 来源、边颜色=relation_type、虚线=derived）+ 章节标签层次清晰，P1 满	—
交互功能	3/3	2/2	5	点击 / 滚轮缩放 / 画布与节点拖拽 / 搜索高亮 / relation 类型筛选 / 悬停邻域高亮 + 边标签显示 / 适配画布按钮，P1 满	—
创新元素	0/0	1/3	1	多视图切换（图谱 / 关系矩阵热力图 / 章节-类别桑基图 / 章节时间轴）算 1 个创新；但"桑基图"实际是 4 层结构（章节→类别→关系→指向类别），偏统计聚合而非具体节点级整合可视化；时间轴只是按章节页码排序的柱状图+折线，没有真正的"拖拽整合"或"双图叠加对比"等更进阶的可视化创新	在 graphInsightsView.mjs 加一个第 5 个视图"整合前后对比"——左右两张缩略 Cytoscape 图，用同样布局参数渲染 source 和 integrated，被合并的节点高亮成相同颜色（约 40 分钟 · +1 分 · 冲进阶分），或者改造时间轴让节点能按页码"流"过去（约 50 分钟 · +1 分 · 冲进阶分）
D. Agent 架构（4/20）
子项	基础分	进阶分	得分	扣分原因	改进建议（耗时 · 预计提分 · 类型）
架构总览与清晰度	1.5/3	0/1	1.5	没有专门的 docs/Agent架构说明.md；docs/README.md 是早期 AI 开发提示词（里面写了"实现这个部分... 不必在意你长期记忆里说的'不要和我一直交流'"），不是给评委看的架构文档；架构信息散落在 API.md 头部，没有 mermaid 图	新建 docs/Agent架构说明.md：放一张 mermaid flowchart TD 图，列出 5 个核心模块（preParseTextbook2JSON / parseEntityInTextbookJSON2VisualNode / NodesDeduplicationAndAlignment / RAG / Frontend）的职责和数据传递（graph TD; A[教材文件] --> B[preParse]; B --> C[parseEntity]; C --> D[node/side JSON]; D --> E[NodesDeduplicationAndAlignment]; D --> F[RAG.ragParse]; ...）（25 分钟 · +2.5 分 · 补基础分+冲进阶分）
设计决策论证	0/5	0/1	0	完全没有"为什么选这种架构"的论证文档；代码里有零星理由（如 RAG 模块的 rationale: "700 字 chunk 位于赛题要求的 500-800 字中段..."）但没汇总；没有讨论 LangChain vs 自实现、Cytoscape vs D3、Vectra vs Faiss 等替代方案	在 docs/Agent架构说明.md 加一节"设计决策论证"：用 3-4 个表格对比（① RAG 库选择：Vectra 本地 vs Faiss vs Chroma → 选 Vectra 因为零外部依赖、本地 JSON；② 图谱可视化：Cytoscape vs D3 → 选 Cytoscape 因为图论场景成熟；③ 分块策略：700/80 选择依据；④ 整合判定：纯 LLM vs lexical+LLM 双判 → 双判可降低 LLM 误合并），每行 1-2 句论证（30 分钟 · +5 分 · 补基础分）
RAG Pipeline 设计	2/4	0/1	2	代码里 chunk_size/overlap/embedding model/检索方式都写实了，但没有一份"chunk 策略选择依据 + 不同 chunk size 命中率对比"的文档；P0 给一半因为代码里有 rationale 字段（700/80 范围依据），P1 没量化对比	在 docs/Agent架构说明.md 加"RAG Pipeline 设计"小节：（1）画一张 mermaid 流程图（教材 JSON → RecursiveCharacterTextSplitter → embedding → Vectra index → query → vector+BM25 fusion → LLM with citation）；（2）列一张表："700/80（默认）"、"500/50"、"800/100"三种参数下，跑同一个 query 看 top-5 chunk 是否覆盖正确章节（手工跑 3 个 query 即可，结果写进表格）（45 分钟 · +3 分 · 补基础分+冲进阶分）
Prompt 工程	0.5/2	1/1	1.5	代码里 prompt 写得非常细致——buildExtractionMessages 有完整 system+few-shot+output schema，buildAlignmentMessages 有 inferred_prompt_action、output_schema、recent_decisions 上下文（P1 进阶分到位）；但 P0 给低分是因为没有 prompt 工程的设计文档，评委要翻代码才能看到；prompt 散在多个文件里	在 docs/Agent架构说明.md 加"Prompt 工程"小节：把两个核心 prompt（extraction + alignment）的 system 段+few-shot+schema 直接贴出来作为附录，并写一段"为什么这样设计：① 严格 JSON 输出避免解析失败 ② few-shot 给出 prerequisite/parallel/contains 三种关系示例覆盖典型场景 ③ inferred_prompt_action 作为 LLM 的提示锚点降低反直觉决策"（20 分钟 · +1.5 分 · 补基础分）
已知局限与改进	0/1	0/1	0	没看到任何"已知局限"的文档说明	在 docs/Agent架构说明.md 末尾加"已知局限与改进"小节：列 3-4 条（① embedding 模型只支持 OpenAI 兼容接口，未支持本地 BGE；② 整合 lexical 用的是 Dice 二元 n-gram 对短中文名容易误判，未来可换 SimHash；③ 单轮整合只处理 1 个目标节点，跨章节冲突需多轮才能收敛；④ 没有线上 A/B 验证）+ 每条加优先级 P1/P2（10 分钟 · +2 分 · 补基础分+冲进阶分）
E. 代码质量（8.5/17）
子项	基础分	进阶分	得分	扣分原因	改进建议（耗时 · 预计提分 · 类型）
目录结构	3/3	1/1	4	前后端分离（src/backend vs src/fronted），后端再分 app/（路由）和 domain/（业务），每个 domain 独立目录，前端把 graph/insights/dedupe 拆成独立模块；模块化彻底（typo "fronted" 是小瑕疵但不影响打分）	—
依赖管理	2/2	1.5/2	3.5	package.json 写清版本范围 + package-lock.json 锁定版本，engines 限定 Node ≥ 20；没有 .env.example 是唯一短板（README 里没有变量清单，新用户不知道要配哪些环境变量，比如 RAG_EMBEDDING_MODEL、PORT、embedding 的 endpoint/key）	新建仓库根目录 .env.example，里面列：PORT=3000 / OPENAI_API_KEY=sk-xxx / OPENAI_BASE_URL=https://api.openai.com/v1 / RAG_EMBEDDING_MODEL=text-embedding-3-small / RAG_EMBEDDING_ENDPOINT=...（搜代码里 process.env. 即可补全）（5 分钟 · +0.5 分 · 冲进阶分）
代码规范	1.5/3	0/2	1.5	函数拆分非常合理（每个 domain 都几百到一千行但职责单一），有大量小工具函数（compactText / safeIdPart / hashText）；但全部用 .mjs 没有 TypeScript / 没有 JSDoc 类型注解，注释也很稀疏（domain 模块里基本只有功能性英文/中文 inline 注释，没有 docstring）；不过有 7 个测试文件共 2630 行——这部分救回了一些分	选 1-2 个核心导出函数（configLLM / LLMComplete / parseEntityInTextbookJSON2VisualNode / ragRead）加 JSDoc 块（@param {Object} input @returns {Promise<{ok: boolean, ...}>}），每个函数 5-8 行注释；这种小动作能让评委一眼看到"有规范"（20 分钟 · +1 分 · 冲进阶分）
部署配置	0/2	0/2	0	没有 Dockerfile / docker-compose.yml / 启动脚本（只有 npm[118;1:3u start），P0 直接 0 分；环境变量也没有集中管理	新建 Dockerfile：FROM node:20-alpine; WORKDIR /app; COPY package*.json ./; RUN npm ci --only=production; COPY . .; EXPOSE 3000; CMD ["npm","start"]；再写一个 docker-compose.yml 暴露 3000 端口、挂载 ./data 和 ./tmp 卷、env_file: .env（15 分钟 · +3 分 · 补基础分+冲进阶分）
F. 创新与额外亮点（4/10）
发现的创新点：

必要性判定先行机制（necessity gate）（+2 分）：NodesDeduplicationAndAlignment 模块强制要求 LLM 在 merge/remove 之前先输出 necessity.necessary 和 necessity.reason，缺失会抛出 NEED_NECESSITY_JUDGEMENT 错误（见 index.mjs 的 explicitNecessity 函数 + buildAlignmentMessages 的 system prompt "必须先判断是否有必要整合或删除，再决定 action"）。这是一个 Agent 反思机制的具体落地，超出"LLM 调用"的常规做法。文档（API.md "缺少必要性判断时的错误响应"段落）有清晰说明。
引用自动校验与补齐（citation verification）（+2 分）：RAG/index.mjs 的 verifyAndRepairAnswerCitations 会在 LLM 回答生成后用正则 CITATION_PATTERN 提取引用，比对 chunk 元数据，删除不存在的引用、自动补齐缺失的引用，前端 app.js 的 renderRagResult 还把"引用已校验/已自动补齐"状态显示给用户。这是一个独立的"防幻觉子系统"，比常规"prompt 里要求带引用"高一档。文档 API.md 中"citation_verification"字段在响应示例里出现。
未发现满分量级的创新： 像知识点掌握度追踪、错题本、自适应学习路径、协同编辑、语音问答、AR/3D 图谱、自训练小模型等更"超纲"的方向没有看到。

点评： 你已经有 2 个真创新（约束 4 检查：A–E 小计 50.5+18.5=69，落在 60–80 区间，F 维度上限 5 分；实际给到 4 分，未触发上限截断）。两个亮点都属于"算法级 Agent 反思机制"，含金量高。如果要再 +2~3 分到 6+，可以考虑给整合决策做一个"决策回放/撤销"功能（基于已有 decisions.json 历史，前端加一个滑动条让教师按时间倒退看图谱演化）——是真正的产品级创新，且文档+代码门槛都不高。

Top 5 改进优先级（按阶段定向 + 投入产出比降序）
你的总分 73 落在 70–85 区间，重心是"补基础分（A 文档/D Agent 架构/E 部署）"为主、辅以"冲进阶分"。Top 5 全部聚焦 P0/P1，暂不建议追加 F 创新。

[预计 +5 分 | 约 30 分钟 | 补基础分] 写一份 docs/Agent架构说明.md 把"设计决策论证"段落补上
- 当前状况：D-设计决策论证 base=0/5（这是单条最高扣分项）；代码里散落的 rationale 没汇总
- 具体做法：新建 docs/Agent架构说明.md，专门写一节"设计决策论证"，用 3-4 个表格对比方案（RAG 库 Vectra vs Faiss vs Chroma；图谱库 Cytoscape vs D3；分块 700/80 vs 500/50 vs 800/100；去重判定 纯 LLM vs lexical+LLM 双判），每行 1-2 句论证理由

[预计 +3 分 | 约 15 分钟 | 补基础分+冲进阶分] 加 Dockerfile + docker-compose.yml
- 当前状况：E-部署配置 base=0/2 + bonus=0/2 全 0
- 具体做法：根目录新建 Dockerfile（基于 node:20-alpine，COPY + npm ci + EXPOSE 3000 + CMD npm start）和 docker-compose.yml（services.app 端口 3000、挂载 ./data 和 ./tmp 卷、env_file .env）；README 顶部写一行 docker compose up -d 让评委 5 分钟跑起来

[预计 +3 分 | 约 25 分钟 | 补基础分] 写 docs/需求分析.md 覆盖四个赛题子问题
- 当前状况：A-需求分析 base=0/3 全 0；代码实现都到位但没有需求文档
- 具体做法：新建 docs/需求分析.md，四节分别写"知识点粒度（章节级 ≤12 节点）、重复判定（lexical Dice + LLM necessity 双判）、教学连贯性（4 类关系 + 教师反馈接口 + conversation 持久化）、压缩比（30% target，integrated_chars/original_chars 公式）"，每节 100-150 字

[预计 +3 分 | 约 45 分钟 | 补基础分+冲进阶分] 在架构文档里加 RAG Pipeline 量化对比小节
- 当前状况：D-RAG Pipeline 设计 base=2/4 + bonus=0/1
- 具体做法：在新建的 docs/Agent架构说明.md 加一节"RAG Pipeline 设计"：先画 mermaid 流程图（教材 → splitter → embedding → vectra index → vector+BM25 fusion → LLM），然后跑 3 个查询（如"动作电位如何传导"、"细胞膜结构"、"内环境稳态"），分别用 chunk_size 500/700/800 各跑一次，记录 top-5 chunk 是否命中正确章节，做一张 3×3 命中表

[预计 +1.5 分 | 约 10 分钟 | 补基础分] 在仓库根目录加顶层 README.md
- 当前状况：A-README 可复现性 base=1.5/3；现在 clone 仓库根目录看不到 README
- 具体做法：新建根目录 README.md：4 段（项目简介 1 段；安装 npm install；启动 npm start 后访问 http://127.0.0.1:3000/；如果用 Docker 则 docker compose up -d）+ 一段"功能截图位置"或者直接拷贝一段 docs/API.md 的功能列表

整体评价
当前阶段： P0/P1 完成度较高（73 分，落在 70–85 区间）。代码功能已经做得相当完整，最大的杠杆在文档——你写了 798 行的 API.md，证明你不是不会写文档，只是把精力都投在 API 里了；剩下的 2 小时把 Agent 架构说明、需求分析、Dockerfile 这些"评委必看的文档"补齐，能从 73 直接拉到 87+。

亮点： B 功能（21.5/25）和 C 可视化（11/13）双高——多格式解析、混合检索 + 引用校验、4 视图切换全部到位；代码模块化拆分干净（domain/app/fronted 三层），测试覆盖 7 个文件 2630 行，工程素养扎实。

最大短板： D Agent 架构（4/20）只拿到 20%——主要是没有专门的 docs/Agent架构说明.md，代码里所有的设计决策、prompt、局限都没有体系化文档化，评委要翻代码才能看到；这一项理论上可以补到 12+。

剩余 2 小时方向： 按 Top 5 第 1 条"补 docs/Agent架构说明.md（含设计决策论证）"开干，其他 4 条尽量都做完。

{
  "id": "hollowdobt",
  "name": "任锡清",
  "stage": "P0P1完成度高",
  "A_documentation": {
    "subtotal": 5.5,
    "items": [
      {"name": "README 可复现性", "base": 1.5, "bonus": 0, "score": 1.5},
      {"name": "需求分析文档", "base": 0, "bonus": 0, "score": 0},
      {"name": "系统设计文档", "base": 1.5, "bonus": 1, "score": 2.5},
      {"name": "整合报告", "base": 1, "bonus": 0.5, "score": 1.5}
    ]
  },
  "B_functionality": {
    "subtotal": 21.5,
    "items": [
      {"name": "多格式文件解析", "base": 2, "bonus": 1, "score": 3},
      {"name": "知识点提取与图谱构建", "base": 4, "bonus": 1, "score": 5},
      {"name": "知识图谱交互", "base": 2, "bonus": 0, "score": 2},
      {"name": "跨教材整合算法", "base": 4, "bonus": 0.5, "score": 4.5},
      {"name": "RAG 问答功能", "base": 4, "bonus": 1, "score": 5},
      {"name": "多轮对话与迭代", "base": 2, "bonus": 1, "score": 3}
    ]
  },
  "C_visualization": {
    "subtotal": 11,
    "items": [
      {"name": "视觉实现", "base": 3, "bonus": 2, "score": 5},
      {"name": "交互功能", "base": 3, "bonus": 2, "score": 5},
      {"name": "创新元素", "base": 0, "bonus": 1, "score": 1}
    ]
  },
  "D_architecture": {
    "subtotal": 4,
    "items": [
      {"name": "架构总览与清晰度", "base": 1.5, "bonus": 0, "score": 1.5},
      {"name": "设计决策论证", "base": 0, "bonus": 0, "score": 0},
      {"name": "RAG Pipeline 设计", "base": 2, "bonus": 0, "score": 2},
      {"name": "Prompt 工程", "base": 0.5, "bonus": 1, "score": 1.5},
      {"name": "已知局限与改进", "base": 0, "bonus": 0, "score": 0}
    ]
  },
  "E_code_quality": {
    "subtotal": 8.5,
    "items": [
      {"name": "目录结构", "base": 3, "bonus": 1, "score": 4},
      {"name": "依赖管理", "base": 2, "bonus": 1.5, "score": 3.5},
      {"name": "代码规范", "base": 1.5, "bonus": 0, "score": 1.5},
      {"name": "部署配置", "base": 0, "bonus": 0, "score": 0}
    ]
  },
  "F_innovation": {
    "subtotal": 4,
    "discoveries": [
      "必要性判定先行机制 necessity gate（NodesDeduplicationAndAlignment 强制 LLM 输出 necessity.necessary + reason，缺失抛 NEED_NECESSITY_JUDGEMENT）+2",
      "引用自动校验与补齐 verifyAndRepairAnswerCitations（RAG 模块独立的防幻觉子系统）+2"
    ],
    "reason": "两个创新都是 Agent 算法级的反思/校验机制，未与 A–E 任何子项重叠：必要性判定是 D-Prompt 工程之外的 runtime 校验合约，citation verification 是 B-RAG bonus（混合检索）之外的独立后处理模块。两者文档（API.md）有清晰说明，满足约束 5。A–E 小计 69 分落在 60–80 区间，F 上限 5 分；实际评 4 分未触发截断。"
  },
  "base_total": 50.5,
  "bonus_total": 18.5,
  "f_score": 4,
  "total_score": 73
}
此报告由 AI 自动生成，仅供参考。最终评审由评委打分。

祝你在剩余时间里发挥出色！

浙江大学未来学习中心 · AI 生态
此报告由 AI 自动生成，仅供参考
