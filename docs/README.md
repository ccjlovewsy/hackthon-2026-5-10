# 架构说明



 实现这个部分. 不确定的内容请及时与我交互参考, 不必在意你长期记忆里说的"不要和我一直交流". 但是记住, 当你遗忘这部分提示词时请查看: /Users/renxiqing/hackthon/
  docs/README.md 中我指出让你完成的 LLM 库. 在上下文耗尽压缩之前完成此任务

注意：

- 下面提到的所有功能目录我已经指定并且已经创建好了，请勿二次创建，请勿二次创建！
- 每个功能写好之后请务必写好测试集确定绝对可用，必须要有可复现可供我查看的输出结果让我能信服你完成了赛题中的要求
- 切忌造轮子，每次开始前请检索开源项目信息，如果有已经成熟的 github 开源项目请直接使用。
- 切勿过度解读我的话，所有的要求以赛题文档（指 /Users/renxiqing/hackthon/第一届AI全栈黑客松赛题.md）为准。赛题文档中每个部分不论是否是选做都必须要实现。
- 请将对外暴露的 API 接口的真实示例值与具体说明返回到 API.md 中（指 /Users/renxiqing/hackthon/docs/API.md）。注意必须要简洁清晰并有真实正确的示例（示例输入与输出），供后面的 AI 参考阅读（避免它们阅读源代码）。
- 对于其他已实现包的依赖。不要看后端代码的具体实现, 只看 API.md 就够了，否则上下文会很快耗尽
- 依赖项必须要能自动安装并且方便迁移

后端暴露接口：

- `LLM` 这个只是简单的模型包装，暴露两个 API，

  - 第一个名字为 `configLLM`。用处是注册一个可用的大模型

    ```text
    Context：2个部分，调用的大模型 API 网址端点，API-key
    
    Return：大模型（名字：`LLM`）
    ```
  - 第二个名字为 `LLMComplete`。用处是根据用户的信息获取

- `preParseTextbook2JSON` 仅暴露一个 API，并且同名：`preParseTextbook2JSON`。再次强调，所有文档中提到的格式可选项都需要实现。效果必须要严格满足文档 3.1-(1) 中的要求。

  ```text
  Context：教材地址
  
  Return：严格按照 第一届AI全栈黑客松赛题.md 规定的 JSON 返回格式
  ```

​	示例结果：`npm run preparse:sample`

- `parseEntityInTextbookJSON2VisualNode` 暴露两个 API。

  - 第一个 API 同名：`parseEntityInTextbookJSON2VisualNode`。

    ```text
    Context：上一步通过调用 `preParseTextbook2JSON` API 解析得到的 JSON（你不需要关注这里面的细节，你只需知道它会得到完整的正文 JSON 内容就行以及返回的 JSON 规范即可）。调用的模型（类型：configLLM 得到的 `LLM`，同样不用管具体的实现细节）
    
    Return：一个庞大的 `JSON`，这个 JSON 介意视作图这种数据结构进行解析。这里面既存储了赛题 3.1-(2) 中规定的节点信息，还存储了与之有关联的节点。其他注意点在这个章节部分有明确说明，请严格以之为准（不要以我说的为准），并且里面提到的注意事项与选做点等必须要全部关注和实现
    ```

  - 第二个 API 的功能是把第一个 API 返回的庞大的 JSON 中的每个节点和关系按照验收标准输出成两个 JSON 文件供前端使用（不用关注前端，你只需要把 JSON 输出到 data/ 目录（/Users/renxiqing/hackthon/data）下即可）。

    ```text
    Context：无
    
    Return：无
    ```

- `NodesDeduplicationAndAlignment` 暴露一个同名 API。其功能是将 data 目录（/Users/renxiqing/hackthon/data）下记录的节点（node/）和对应的边（side/）进行合并整合，把下面的所有 JSON 文件中的节点与节点对应的边严格按照赛题文档的 3.1-(4) 和 3.1-(7) 的要求进行合并消解，精简删除掉重复的内容。唯一需要注意的是调用一次这个 API 只会进行一个节点的整合，不会一次性整合多个节点。

  ```text
  Context：调用的模型（类型：configLLM 得到的 `LLM`，不用管具体的实现细节）和用户的提示词。
  
  Return：返回 JSON:本轮是否实际改图、最终动作、必要性判断、决策 ID、压缩/节点统计和输出文件路径
  ```

- `RAG` 暴露两个 API。

  - 第一个 API 是 `ragParse`，其功能参考赛题文档的 3.1-(5)（严格要求，不是简单看看就行）。生成的 RAG 知识库请放到 `data/rag` （/Users/renxiqing/hackthon/data/rag）目录下。

    ```text
    Context：调用的模型（类型：`LLM`）
    
    Return：无
    ```

  - 第二个 API 是 `ragRead`，其功能同样参考赛题文档的 3.1-(5) （严格要求，不是简单看看就行）。

    ```text
    Context：调用的模型（类型：`LLM`），用户提示词
    
    Return：找到发现的内容与解释等等一切文档规定必要的内容
    ```

前端交互：

- 严格参考文档 3.1-(3) 和 3.1-(8) 中的要求进行实现，在此不多做赘述。所有必要的后端组件我已给出（一样，请严格参考 API.md），请你自行利用调用好。参考的 UI css 风格：`https://gomami.io/`，`https://claude.ai/`。
