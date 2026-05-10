import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "outline" | "danger";
type Size = "sm" | "md" | "lg";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
	variant?: Variant;
	size?: Size;
};

const variants: Record<Variant, string> = {
	primary:
		"bg-gradient-to-r from-brand-500 to-accent-500 text-white shadow-lg shadow-brand-500/20 hover:shadow-brand-500/40 hover:brightness-110",
	secondary: "bg-white/10 text-white hover:bg-white/15",
	ghost: "text-zinc-200 hover:bg-white/5",
	outline: "border border-white/15 text-white hover:bg-white/5",
	danger: "bg-red-500/90 text-white hover:bg-red-500",
};

const sizes: Record<Size, string> = {
	sm: "px-3 py-1.5 text-xs",
	md: "px-4 py-2 text-sm",
	lg: "px-5 py-3 text-base",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
	{ className, variant = "primary", size = "md", ...props },
	ref,
) {
	return (
		<button
			ref={ref}
			className={cn(
				"inline-flex items-center justify-center gap-2 rounded-lg font-medium transition disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400",
				variants[variant],
				sizes[size],
				className,
			)}
			{...props}
		/>
	);
});
