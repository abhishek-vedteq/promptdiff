# Using as a library

promptdiff also exports its building blocks:

```ts
import { runDiff, parseCases, MockProvider, registerProvider } from "promptdiff";

const results = await runDiff({
  provider: new MockProvider(),
  modelSpec: "mock:demo",
  modelId: "demo",
  basePrompt: "You are terse.",
  headPrompt: "You are friendly.",
  cases: parseCases('{"id": "hi", "input": "Hello"}'),
  runs: 3,
  concurrency: 4,
  pricing: {},
});

for (const r of results) console.log(r.id, r.status);
```

## Custom providers

Anything that implements the `Provider` interface works:

```ts
import { registerProvider, type Provider } from "promptdiff";

const myProvider: Provider = {
  id: "acme",
  async generate({ model, system, input, temperature, maxOutputTokens, signal }) {
    // call your API here
    return { text: "...", inputTokens: 10, outputTokens: 20 };
  },
};

registerProvider({
  id: "acme",
  displayName: "Acme AI",
  envVar: "ACME_API_KEY",
  keyUrl: "https://acme.example/keys",
  create: () => myProvider,
});
```

See [`src/index.ts`](../src/index.ts) for everything that's exported.
