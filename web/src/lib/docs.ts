const inference = "https://techdocs.akamai.com/akamai-inference-beta/docs";
const api = `${inference}/use-the-openai-compatible-api-with-akamai-inference`;

export const docs = {
  dashboard: `${inference}/use-the-akamai-inference-dashboard`,
  keys: `${inference}/manage-inference-api-keys`,
  modelLibrary: `${inference}/choose-a-model-from-the-model-library#view-model-details`,
  playground: `${inference}/test-models-in-the-model-playground`,
  usage: `${inference}/monitor-akamai-inference-usage`,
  errors: `${inference}/handle-akamai-inference-errors-and-service-changes`,
  api,
  streaming: `${api}#stream-responses`,
  embeddings: `${api}#create-embeddings`,
  reasoning: `${api}#set-the-reasoning-effort`,
  claudeTools: "https://code.claude.com/docs/en/tools-reference",
  piTools: "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/index.ts",
  cloudApi: "https://techdocs.akamai.com/linode-api/reference/api-summary",
};

// Deployment aliases differ from publisher names. Only link verified releases.
export const modelDocs = new Map<string, string>([
  ["deepseek-v4-flash-0731", "https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731"],
  ["deepseek-v4-pro-0813", "https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro-0813"],
  ["deepseek-v4.1-flash", "https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash"],
  ["gemma-4-26b-a4b-it", "https://huggingface.co/google/gemma-4-26B-A4B-it"],
  ["glm-5.3", "https://huggingface.co/zai-org/GLM-5.3"],
  ["glm-5.3-flash", "https://huggingface.co/zai-org/GLM-5.3-Flash"],
  ["gpt-oss-120b", "https://huggingface.co/openai/gpt-oss-120b"],
  ["kimi-k3", "https://huggingface.co/moonshotai/Kimi-K3"],
  ["nvidia-nemotron-3-ultra", "https://research.nvidia.com/labs/nemotron/Nemotron-3-Ultra/"],
  ["qwen3-5-9b", "https://huggingface.co/Qwen/Qwen3.5-9B"],
  ["qwen3-8-27b", "https://huggingface.co/Qwen/Qwen3.8-27B"],
  ["qwen3-embedding-8b", "https://huggingface.co/Qwen/Qwen3-Embedding-8B"],
]);
