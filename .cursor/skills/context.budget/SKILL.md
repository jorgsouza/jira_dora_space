---
name: context-budget
description: >-
  Reduz consumo de tokens e créditos no Cursor com leitura mínima de contexto.
  Use quando o usuário pedir para "ler só o necessário", diminuir custo,
  definir .cursorignore/.gitignore, limitar escopo, ou trabalhar com contexto grande.
---

# Context Budget (Cursor)

## Objetivo

Ajudar o agente a resolver tarefas com **mínimo contexto necessário**, mantendo qualidade.

## Quando usar

Use esta skill quando o pedido envolver:

- economia de tokens/créditos;
- “Cursor lendo arquivo demais”;
- indexação pesada/lenta;
- necessidade de mais precisão com contexto limitado.

## Workflow padrão (curto)

1. **Definir escopo mínimo**
   - Confirmar objetivo em 1 frase.
   - Listar no máximo 3 caminhos de arquivo iniciais.
2. **Ler de forma progressiva**
   - Abrir só os arquivos do escopo inicial.
   - Expandir apenas se houver bloqueio real.
3. **Resumir antes de expandir**
   - Fazer resumo de 3-5 bullets do que já foi encontrado.
   - Só então abrir novos arquivos, com justificativa curta.
4. **Aplicar higiene de contexto**
   - Usar/ajustar `.cursorignore` para excluir ruído.
   - Manter `.gitignore` sem artefatos de build/teste/cache.
5. **Entregar com rastreabilidade**
   - Explicar decisões por escopo.
   - Citar arquivos realmente usados.

## Regras de ouro

- **Regra 70/30**: 70% do valor vem de 30% dos arquivos.
- Evitar leitura de pastas históricas/documentação grande por padrão.
- Evitar logs longos; usar trechos curtos e relevantes.
- Preferir mudanças pequenas e iterativas (uma feature por vez).

## Template de prompt recomendado (PT-BR)

```text
Contexto mínimo primeiro:
1) Leia apenas: <arquivo A>, <arquivo B>, <arquivo C>.
2) Resuma em até 5 bullets o que encontrou.
3) Só depois proponha mudança.
4) Se precisar expandir, diga exatamente qual arquivo adicional e por quê.
```

## Checklist rápido

- [ ] Escopo inicial ≤ 3 arquivos
- [ ] Houve resumo antes de expandir?
- [ ] `.cursorignore` cobre build/deps/cache/log?
- [ ] Mudança foi incremental e verificável?
