---
domain:
- nlp
tags:
- RAG
- 知识图谱
- 教材解析
license: GPL-3.0
---

# 学科知识整合智能体

面向“AI 全栈极速黑客松”的跨教材知识整合系统。项目支持 PDF、Markdown、TXT、Word、Excel 等教材上传，自动完成教材预解析、知识点抽取、知识图谱可视化、跨教材去重整合、RAG 问答和教师反馈式迭代。

本仓库不依赖固定教材文件，评审时可直接在前端上传赛方提供的教材。`.gitignore` 已排除 PDF、`data/` 和 `origin-textbooks/`，避免把大体积教材推送到 GitHub。

## 快速启动

环境要求：

- Node.js >= 20
- npm >= 10
- Python：不需要，本项目为 Node.js/原生 Web 实现

```bash
npm install
npm start
```

启动后访问：

```text
http://127.0.0.1:3000/
```

进入页面后，在左侧“模型”区域填写 OpenAI-compatible Endpoint、API Key 和默认模型，点击“注册 LLM”。RAG 默认使用 `text-embedding-3-small`，也可以通过 `.env` 或页面请求参数配置 embedding endpoint/key。

常用配置见 `.env.example`：

- `PORT`：Web 服务端口，默认 3000。
- `HOST`：本地默认 `127.0.0.1`；Docker 中由 compose 设置为 `0.0.0.0`。
- `RAG_EMBEDDING_ENDPOINT` / `RAG_EMBEDDING_API_KEY`：OpenAI-compatible embedding 服务。
- `RAG_EMBEDDING_MODEL`：默认 `text-embedding-3-small`。

## Docker 启动

```bash
cp .env.example .env
docker compose up -d
```

服务端口默认映射到 `http://127.0.0.1:3000/`，`data/` 与 `tmp/` 会挂载为本地卷，方便保留教材解析结果、图谱结果和 RAG 索引。

比赛提交的部署链接必须是公网可访问地址，不能填写 localhost。本地 Docker 用于复现和评委快速验证；线上部署时保持同样的 `npm start` 启动命令即可。

## 核心功能

- 多格式教材解析：PDF、MD、TXT、DOCX、XLSX、XLS、CSV、TSV。
- 知识点图谱：章节级抽取，每章默认最多 12 个核心知识点，关系类型限定为 `prerequisite`、`parallel`、`contains`、`applies_to`。
- 跨教材整合：Dice 二元 n-gram 候选召回 + LLM 语义判定 + necessity gate 必要性校验，目标压缩比为 30%。
- RAG 问答：700 字 chunk、80 字 overlap、Vectra 本地向量库、vector + BM25 混合检索，并自动校验/补齐引用。
- 可视化：Cytoscape 交互图谱、关系矩阵、章节-类别桑基图、章节时间轴、源图/整合图切换。

## 常用命令

```bash
npm run preparse:sample
npm run parse-entity:sample
npm run rag:sample
npm test
```

## 文档入口

- [需求分析](docs/需求分析.md)
- [系统设计](docs/系统设计.md)
- [Agent 架构说明](docs/Agent架构说明.md)
- [API 说明](docs/API.md)
- [整合报告](report/整合报告.md)
