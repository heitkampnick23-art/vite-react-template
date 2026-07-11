import { Link } from "react-router-dom";
import { Logo } from "../components/Logo";

function LegalShell({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
	return (
		<div className="mx-auto max-w-3xl px-6 py-16">
			<Link to="/" className="mb-10 inline-block">
				<Logo />
			</Link>
			<h1 className="text-3xl font-bold">{title}</h1>
			<p className="mt-1 text-xs text-zinc-500">Last updated: {updated}</p>
			<div className="mt-8 space-y-6 text-sm leading-relaxed text-zinc-300">{children}</div>
			<div className="mt-12 border-t border-white/5 pt-6 text-xs text-zinc-500">
				<Link to="/" className="underline">← Back to Generate AI</Link>
			</div>
		</div>
	);
}

export function Terms() {
	return (
		<LegalShell title="Terms of Service" updated="July 2026">
			<section>
				<h2 className="mb-2 text-lg font-semibold text-white">1. The service</h2>
				<p>
					Generate AI (generateai.build) is an AI-assisted app building platform. You describe an
					application in chat and the platform generates, previews, and deploys code on your behalf.
				</p>
			</section>
			<section>
				<h2 className="mb-2 text-lg font-semibold text-white">2. Accounts</h2>
				<p>
					You may create an account with your email address and a password, or by signing in with
					Google. You are responsible for keeping your credentials secure and for all activity under
					your account.
				</p>
			</section>
			<section>
				<h2 className="mb-2 text-lg font-semibold text-white">3. Plans and payment</h2>
				<p>
					Generate AI is a paid service. Usage is metered in credits, which are included with a
					subscription plan or purchased as one-time top-ups. Credits have no cash value and are not
					refundable except where required by law. Subscriptions renew monthly until canceled from
					your billing page.
				</p>
			</section>
			<section>
				<h2 className="mb-2 text-lg font-semibold text-white">4. Your content</h2>
				<p>
					You own the code and content you create with the platform. You grant us the limited rights
					needed to store, build, and deploy it at your direction. You must not use the service to
					build or distribute anything unlawful or harmful.
				</p>
			</section>
			<section>
				<h2 className="mb-2 text-lg font-semibold text-white">5. Availability and liability</h2>
				<p>
					The service is provided "as is" without warranties. To the maximum extent permitted by law,
					our total liability is limited to the amounts you paid us in the three months before the
					claim arose.
				</p>
			</section>
			<section>
				<h2 className="mb-2 text-lg font-semibold text-white">6. Contact</h2>
				<p>Questions about these terms: contact us via your account's support channel.</p>
			</section>
		</LegalShell>
	);
}

export function Privacy() {
	return (
		<LegalShell title="Privacy Policy" updated="July 2026">
			<section>
				<h2 className="mb-2 text-lg font-semibold text-white">1. What we collect</h2>
				<p>
					Account details (email, name, avatar), authentication data (a hashed password, or your
					Google account's ID and email if you sign in with Google), billing records processed by
					Stripe, and usage data such as credit consumption and session logs.
				</p>
			</section>
			<section>
				<h2 className="mb-2 text-lg font-semibold text-white">2. How we use it</h2>
				<p>
					To operate your account, meter and bill usage, secure the service, and improve the
					platform. We do not sell your personal information.
				</p>
			</section>
			<section>
				<h2 className="mb-2 text-lg font-semibold text-white">3. Third parties</h2>
				<p>
					Payments are handled by Stripe; we never store your card number. Sign-in with Google is
					handled by Google OAuth. AI generation requests are processed by our model providers under
					contract.
				</p>
			</section>
			<section>
				<h2 className="mb-2 text-lg font-semibold text-white">4. Retention and deletion</h2>
				<p>
					We keep your data while your account is active. You can request deletion of your account
					and associated data at any time from your account page or support channel.
				</p>
			</section>
			<section>
				<h2 className="mb-2 text-lg font-semibold text-white">5. Cookies</h2>
				<p>
					We use a single first-party session cookie to keep you signed in. No third-party ad
					trackers.
				</p>
			</section>
		</LegalShell>
	);
}
