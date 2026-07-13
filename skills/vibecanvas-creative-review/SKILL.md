---
name: vibecanvas-creative-review
description: Review VibeCanvas 2 image candidates with technical checks and real Agent vision, select or request human selection, identify defects, write a directional repair prompt, and persist selected/final Artifact state.
license: MIT
compatibility: opencode, codex, claude-code, mcp
metadata:
  product: vibecanvas
  role: creative-review
  protocol: "2.0"
---

# VibeCanvas Creative Review

Technical image validation and semantic visual review are separate. A valid PNG may still be the wrong design.

## Workflow

1. Read the Run and candidate Artifact IDs.
2. Inspect actual image files and the original brief/reference roles.
3. Compare candidates by the criteria below.
4. If one candidate clearly wins, select it.
5. If taste is decisive or candidates are close, leave `control.human-select` in `needs-input` and ask the user to choose through the visual selector.
6. If all fail, produce one specific repair direction and patch only the affected Prompt Architect constraints.
7. Re-run only the downstream branch.
8. Persist selected/final state and keep rejected candidates as history.

## Criteria

- brief fidelity and subject correctness;
- identity/reference preservation;
- composition and negative space for the target ratio;
- anatomy, geometry, perspective, and object count;
- materials, light, palette, and style consistency;
- requested text readability;
- absence of watermarks, UI chrome, annotations, pseudo-text, duplicate limbs, and accidental objects;
- suitability for avatar, hero, poster, diagram, product image, or other target surface.

## Decision schema

```json
{
  "decision": "pass | retry | manual",
  "selectedIndex": 0,
  "score": 0,
  "issues": [],
  "repairPrompt": "optional"
}
```

Never issue a blind retry with the same prompt. Name the defect and corrective direction.
