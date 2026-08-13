import { cva } from "class-variance-authority"

/**
 * Button 样式变体
 *
 * 独立成文件是为了让 button.tsx 只导出组件——
 * 组件文件混入非组件导出会破坏 Vite 的 Fast Refresh。
 */
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium transition-all cursor-pointer disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-text-primary text-text-inverse rounded-md hover:opacity-85",
        secondary:
          "border border-border bg-transparent text-text-primary rounded-md hover:bg-surface-hover hover:border-text-tertiary",
        outline:
          "border border-border bg-transparent text-text-primary rounded-md hover:bg-surface-hover hover:border-text-tertiary",
        ghost:
          "bg-transparent text-text-secondary rounded-md hover:bg-surface-active hover:text-text-primary",
        destructive:
          "bg-error text-text-inverse rounded-md hover:opacity-85",
        link: "text-text-link underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-10 px-6",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)
