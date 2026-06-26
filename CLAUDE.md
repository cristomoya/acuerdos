# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A multiuser web app ("Gestor de Modelos de Acuerdo") for a Spanish town hall (Ayuntamiento de Totana) to create, edit, and export administrative document templates (acuerdos de Pleno, decretos, convenios, etc.) with dynamic `{{CAMPO}}` placeholders. Backend, frontend, and database content are all in Spanish.

## Architecture

```
Browser → Nginx (frontend, port 8080/9080) → Node.js/Express API (port 3001) → SQLite (/data/acuerdos.db)
                                                       │
                                                       └─ shells out to Python scripts for ODT/PDF export
                                                       └─ calls Anthropic API (Claude Haiku) for AI features
```

- **Frontend**: plain HTML/CSS/JS (no build step, no framework) in [frontend/public/](frontend/public/), served statically by Nginx. [app.js](frontend/public/app.js) is the whole SPA (state, API calls, rendering); [ia-generator.js](frontend/public/ia-generator.js) handles the AI-assisted document generation flow.
- **Backend**: single-file Express server at [backend/server.js](backend/server.js) (no router modules, no ORM — raw `better-sqlite3` prepared statements inline in route handlers). Tables are created with `CREATE TABLE IF NOT EXISTS` directly in server.js on boot; there is no migration system, so schema changes are additive `ALTER TABLE ... ADD COLUMN` wrapped in try/catch.
- **Export pipeline**: Node never renders documents itself. It writes a JSON payload to a temp file and calls a Python script via `execFile` ([backend/scripts/export_odt.py](backend/scripts/export_odt.py), [export_pdf.py](backend/scripts/export_pdf.py)), then reads back the generated file. ODT export builds a fixed institutional layout (header, expediente box, data/economic tables, signature block) from scratch — it does **not** use any `.odt`/`.ott` template file despite the `plantillas` table/upload feature existing in the UI. PDF export uses WeasyPrint.
- **AI features**: `_llamarClaude()` in server.js calls the Anthropic Messages API directly via `fetch` (model `claude-haiku-4-5-20251001`), used for: detecting/replacing `{{CAMPO}}` placeholders in pasted text, and generating a filled acuerdo from PDF antecedentes + extracted signatures. PDF text/signature extraction is done by [extract_pdf_text.py](backend/scripts/extract_pdf_text.py).
- **Auth**: JWT in an httpOnly cookie (`auth_token`) or `Authorization: Bearer`, 8h expiry. Per-IP+email login throttling is in-memory (`loginAttempts` Map), not persisted. Roles: `admin`, `editor`, `consultor` (gated via the `role(...)` middleware — admin: full CRUD + user/category management; editor: create/edit/export; consultor: read/export only).
- **Fields system**: `{{CAMPO}}` placeholders (regex `FIELD_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g`, duplicated identically in server.js and app.js — keep them in sync if changed) are parsed out of model bodies and tracked three ways: per-model types in `campo_tipos`, a global reusable catalog in `campo_catalogo` (seeded from the `CONTRACT_FIELDS` list in server.js), and per-user saved value sets in `expedientes`. Field renaming/migration across all models is done via `/api/admin/rename-campo` and `/api/admin/migrar-campos`.
- **Versioning**: every edit to a `modelos` row snapshots the previous body into `modelo_versiones` (capped at last 20 per model) before overwriting; `/api/modelos/:id/restore` rolls back by re-snapshotting and restoring.

## Running locally

This project is designed to run via Docker Compose; there is no documented non-Docker dev workflow.

```bash
cp .env.example .env   # set JWT_SECRET, optionally ANTHROPIC_API_KEY
docker compose up -d --build
docker compose logs -f backend
```

App: `http://localhost:8080` (or whatever `APP_PORT`/the frontend port-mapping resolves to — see [docker-compose.yml](docker-compose.yml), currently mapped to 9080 externally).

There is no test suite and no lint/build command configured in [backend/package.json](backend/package.json) — verify changes by exercising the running app.

If iterating on the backend outside Docker, it needs Node 20, `better-sqlite3` (native build), and a Python 3 environment with the packages in [backend/requirements.txt](backend/requirements.txt) (`weasyprint`, `markdown-it-py`, `mistune`, `beautifulsoup4`, `lxml`, plus `odfpy`/`pypdf` installed in the Dockerfile but missing from requirements.txt) on `PATH` as `python`/`python3` (override with `PYTHON_BIN`).

## Conventions / things to know before editing

- Routes, helpers, and SQL all live directly in [backend/server.js](backend/server.js) — there's no separation into controllers/services. Follow the existing pattern (inline `db.prepare(...).run()/get()/all()`) rather than introducing an ORM or splitting files, unless asked.
- Field-name regex and the `CONTRACT_FIELDS` catalog are the source of truth for what counts as a valid placeholder and its human-readable label/type — update both client (`app.js`) and server copies together.
- `server_export_patch.js` is a legacy/reference patch file, not wired into the running app (the AI/export routes it describes were already merged into `server.js`, see the "PARCHE server_ia_patch.js" comment block around line 1241 of server.js).
- Money/date/number formatting for field substitution in ODT export follows es-ES conventions (`_formatFieldValue` in server.js): dates as "D de mes de AAAA", amounts as "12.500,00 €".
- Sanitization: `sanitizeName` strips filesystem-unsafe chars for folder/file names; `sanitizeForHeader` additionally strips accents/non-ASCII for use in HTTP `Content-Disposition` headers — use the right one depending on whether the string lands on disk or in a header.
