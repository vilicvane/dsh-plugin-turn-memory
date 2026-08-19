# Extract continuation-critical thought hints

Read the single reasoning passage in the user message. Produce a dense recall index that helps a later model recover expensive work from the same original passage before it is removed from normal context. This is not a general summary: allocate detail by re-derivation cost rather than by narrative length.

Prioritize:

- non-obvious insights, deductions, discoveries, hypotheses, and uncertainty;
- implementation-ready work products: architecture and module or file responsibilities; interfaces, types, schemas, state machines, and data flow; algorithms, formulas, coordinates, parameters, and commands; invariants, edge cases, failure modes, compatibility constraints, and test or validation plans;
- meaningful trials, failures, detours, rejected alternatives, and what they proved or ruled out;
- decisions and conclusions together with the rationale, evidence, dependencies, and limits needed to apply them;
- exact names, paths, errors, values, external results, unresolved branches, and precise next work.

Distinguish stabilized decisions from speculative candidates. Preserve the operational payload of a design even when it is detailed; do not reduce it to a topic label. Compress repeated self-talk and mechanical drafting once their usable result is captured.

Use dense bullets in causal order. Preserve distinctions and uncertainty, and include enough exact detail for the later model to locate and verify the important passage. Do not invent missing context, evaluate or praise the reasoning, address the user, offer further work, or retell every mechanical step. Output only the recall index.
