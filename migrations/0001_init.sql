-- Generate AI — initial schema
-- D1 (SQLite). All ids are nanoid strings unless noted.

PRAGMA foreign_keys = ON;

CREATE TABLE users (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL UNIQUE,
	name TEXT,
	avatar_url TEXT,
	github_id TEXT UNIQUE,
	google_id TEXT UNIQUE,
	plan TEXT NOT NULL DEFAULT 'free',
	stripe_customer_id TEXT UNIQUE,
	token_balance INTEGER NOT NULL DEFAULT 100000,
	role TEXT NOT NULL DEFAULT 'user',
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE TABLE sessions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	expires_at INTEGER NOT NULL,
	ip TEXT,
	ua TEXT,
	created_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE oauth_states (
	state TEXT PRIMARY KEY,
	provider TEXT NOT NULL,
	code_verifier TEXT,
	redirect TEXT,
	expires_at INTEGER NOT NULL
);

CREATE TABLE magic_links (
	token TEXT PRIMARY KEY,
	email TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_magic_email ON magic_links(email);

CREATE TABLE projects (
	id TEXT PRIMARY KEY,
	owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	slug TEXT NOT NULL UNIQUE,
	description TEXT,
	template TEXT,
	visibility TEXT NOT NULL DEFAULT 'private',
	github_repo TEXT,
	subdomain TEXT UNIQUE,
	framework TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX idx_projects_owner ON projects(owner_id);

CREATE TABLE project_members (
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	role TEXT NOT NULL DEFAULT 'editor',
	created_at INTEGER NOT NULL,
	PRIMARY KEY (project_id, user_id)
);

CREATE TABLE files (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	path TEXT NOT NULL,
	content_inline TEXT,
	content_r2_key TEXT,
	size INTEGER NOT NULL DEFAULT 0,
	hash TEXT,
	mime TEXT,
	updated_at INTEGER NOT NULL,
	UNIQUE (project_id, path)
);
CREATE INDEX idx_files_project ON files(project_id);

CREATE TABLE file_versions (
	id TEXT PRIMARY KEY,
	file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
	hash TEXT NOT NULL,
	author_id TEXT REFERENCES users(id),
	message TEXT,
	created_at INTEGER NOT NULL
);
CREATE INDEX idx_fileversions_file ON file_versions(file_id);

CREATE TABLE deployments (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	version INTEGER NOT NULL,
	status TEXT NOT NULL DEFAULT 'queued',
	url TEXT,
	build_log_r2 TEXT,
	commit_sha TEXT,
	error TEXT,
	created_at INTEGER NOT NULL,
	completed_at INTEGER
);
CREATE INDEX idx_deployments_project ON deployments(project_id);

CREATE TABLE secrets (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	key TEXT NOT NULL,
	ciphertext TEXT NOT NULL,
	iv TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	UNIQUE (project_id, key)
);

CREATE TABLE subscriptions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	stripe_sub_id TEXT NOT NULL UNIQUE,
	plan TEXT NOT NULL,
	status TEXT NOT NULL,
	current_period_end INTEGER NOT NULL,
	cancel_at INTEGER,
	seats INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE TABLE invoices (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	stripe_invoice_id TEXT NOT NULL UNIQUE,
	amount_cents INTEGER NOT NULL,
	currency TEXT NOT NULL DEFAULT 'usd',
	status TEXT NOT NULL,
	hosted_url TEXT,
	created_at INTEGER NOT NULL
);

-- token_ledger: every credit/debit; sum equals user.token_balance changes.
CREATE TABLE token_ledger (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
	delta INTEGER NOT NULL,
	reason TEXT NOT NULL,
	model TEXT,
	request_id TEXT,
	created_at INTEGER NOT NULL
);
CREATE INDEX idx_ledger_user ON token_ledger(user_id, created_at);

CREATE TABLE token_usage (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
	model TEXT NOT NULL,
	prompt_tokens INTEGER NOT NULL,
	completion_tokens INTEGER NOT NULL,
	cost_micro_usd INTEGER NOT NULL,
	tokens_charged INTEGER NOT NULL,
	request_id TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL
);
CREATE INDEX idx_usage_user ON token_usage(user_id, created_at);

CREATE TABLE council_runs (
	id TEXT PRIMARY KEY,
	project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	prompt TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'running',
	transcript_r2 TEXT,
	final_plan TEXT,
	tokens_used INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	completed_at INTEGER
);
CREATE INDEX idx_council_user ON council_runs(user_id, created_at);

CREATE TABLE council_turns (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES council_runs(id) ON DELETE CASCADE,
	idx INTEGER NOT NULL,
	role TEXT NOT NULL,
	model TEXT NOT NULL,
	content TEXT NOT NULL,
	tokens INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL
);
CREATE INDEX idx_turns_run ON council_turns(run_id, idx);

CREATE TABLE heal_events (
	id TEXT PRIMARY KEY,
	deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	error_signature TEXT NOT NULL,
	log_excerpt_r2 TEXT,
	fix_diff TEXT,
	fix_pr_url TEXT,
	status TEXT NOT NULL DEFAULT 'pending',
	created_at INTEGER NOT NULL,
	resolved_at INTEGER
);
CREATE INDEX idx_heal_project ON heal_events(project_id, created_at);

CREATE TABLE templates (
	id TEXT PRIMARY KEY,
	slug TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	description TEXT,
	repo_url TEXT,
	preview_image TEXT,
	tags TEXT,
	featured INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
	id TEXT PRIMARY KEY,
	user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
	action TEXT NOT NULL,
	target TEXT,
	meta_json TEXT,
	ip TEXT,
	created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_user ON audit_log(user_id, created_at);

-- Seed a few starter templates
INSERT INTO templates (id, slug, name, description, tags, featured, created_at) VALUES
	('tpl_react', 'react-vite', 'React + Vite', 'Modern React 19 + Vite + TypeScript starter.', 'react,vite,typescript', 1, strftime('%s','now') * 1000),
	('tpl_hono', 'hono-api', 'Hono API', 'Cloudflare Workers + Hono backend starter.', 'hono,workers,api', 1, strftime('%s','now') * 1000),
	('tpl_landing', 'landing-page', 'Landing Page', 'Tailwind landing page with hero + pricing.', 'landing,tailwind,marketing', 1, strftime('%s','now') * 1000),
	('tpl_saas', 'saas-starter', 'SaaS Starter', 'Full-stack SaaS with auth, billing, and dashboard.', 'saas,auth,stripe', 0, strftime('%s','now') * 1000);
