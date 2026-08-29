# Contents

- `query-kb/` – scoped knowledge-base retrieval.
- `plan-kb/` – durable implementation planning in the knowledge base.
- `percolate-kb/` – evidence-backed concept and relationship promotion.
- `refresh-kb/` – knowledge-graph refresh and validation.
- `save-url-kb/` – auditable public and signed-in web capture.
- `save-pdf-kb/` – auditable PDF conversion with OCR and image evidence.
- `write-phase-plan/` – dependency-ordered plan authoring with explicit acceptance and validation criteria.
- `phase-orchestrator/` – parent workflow for delegated phased execution, integration, and delivery.
- `phase-implementer/`, `phase-reviewer/`, and `phase-final-reviewer/` – bounded implementation, independent phase review, and end-to-end review workers.
- `../../skills/atet/` – Atet's product-specific media and workflow skill; it remains in the public product skill root.

# Guidelines

- Keep each portable skill self-contained with `SKILL.md`, its closest `AGENTS.md`, matching `agents/openai.yaml`, and only the references its workflow needs.
- Keep these cross-repository workflows vendored and independently usable; never resolve a skill through a sibling checkout or Git submodule.
- Refresh the KB skills from one reviewed immutable `hraness/kb` release and the orchestration pack from the pinned upstream release, then validate the complete copied directories.
- Keep product-specific operating skills in the root `skills/` directory when present. Portable repository workflows belong here.
- Mark every portable repository workflow with `metadata.internal: true` so public `skills add hraness/atet` discovery exposes only the product-owned `atet` skill.
- Preserve upstream attribution and license notices for adapted public resources.
