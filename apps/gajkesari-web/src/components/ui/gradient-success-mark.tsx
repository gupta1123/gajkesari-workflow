import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

const sizeClasses = {
  sm: "h-6 w-6 rounded-lg [&_svg]:h-3.5 [&_svg]:w-3.5",
  md: "h-9 w-9 rounded-xl [&_svg]:h-5 [&_svg]:w-5",
} as const;

export function GradientSuccessMark({
  className,
  size = "sm",
}: {
  className?: string;
  size?: keyof typeof sizeClasses;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center bg-[linear-gradient(150deg,#f1c889_0%,#e3a64a_45%,#4ca154_100%)] text-white",
        sizeClasses[size],
        className,
      )}
    >
      <Check strokeWidth={2.25} />
    </span>
  );
}
