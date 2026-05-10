import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			className={cn(
				"glass rounded-2xl p-6 shadow-xl shadow-black/40",
				className,
			)}
			{...props}
		/>
	);
}
