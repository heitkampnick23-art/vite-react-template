// Thin D1 wrapper. We use raw SQL via prepared statements — fast, typed, no ORM overhead.
// For complex queries Drizzle is added but not required here.

export type DB = D1Database;

export const now = () => Date.now();

export async function getUserById(db: DB, id: string) {
	return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

export async function getUserByEmail(db: DB, email: string) {
	return db
		.prepare("SELECT * FROM users WHERE email = ?")
		.bind(email.toLowerCase())
		.first<UserRow>();
}

export async function getSession(db: DB, id: string) {
	return db
		.prepare("SELECT * FROM sessions WHERE id = ? AND expires_at > ?")
		.bind(id, now())
		.first<SessionRow>();
}

export async function deleteSession(db: DB, id: string) {
	await db.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
}

export type UserRow = {
	id: string;
	email: string;
	name: string | null;
	avatar_url: string | null;
	github_id: string | null;
	google_id: string | null;
	plan: "free" | "pro" | "team" | "enterprise";
	stripe_customer_id: string | null;
	token_balance: number;
	role: "user" | "admin";
	created_at: number;
	updated_at: number;
};

export type SessionRow = {
	id: string;
	user_id: string;
	expires_at: number;
	ip: string | null;
	ua: string | null;
	created_at: number;
};

export type ProjectRow = {
	id: string;
	owner_id: string;
	name: string;
	slug: string;
	description: string | null;
	template: string | null;
	visibility: "private" | "public";
	github_repo: string | null;
	subdomain: string | null;
	framework: string | null;
	created_at: number;
	updated_at: number;
};

export function rowToUserPublic(u: UserRow) {
	return {
		id: u.id,
		email: u.email,
		name: u.name,
		avatarUrl: u.avatar_url,
		plan: u.plan,
		tokenBalance: u.token_balance,
		role: u.role,
	};
}

export function rowToProject(p: ProjectRow) {
	return {
		id: p.id,
		slug: p.slug,
		name: p.name,
		description: p.description,
		template: p.template,
		visibility: p.visibility,
		subdomain: p.subdomain,
		framework: p.framework,
		createdAt: p.created_at,
		updatedAt: p.updated_at,
	};
}
