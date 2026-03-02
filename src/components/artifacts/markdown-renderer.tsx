import { useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Copy, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import 'highlight.js/styles/github-dark-dimmed.min.css'

interface MarkdownRendererProps {
  content: string
  className?: string
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    const text = preRef.current?.textContent ?? ''
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 静默失败
    }
  }

  return (
    <div className="relative group/code my-3 rounded-lg overflow-hidden">
      <pre
        ref={preRef}
        className="!bg-[#1E1E1C] !m-0 text-[#EDEDEB] p-4 overflow-x-auto text-[13px] leading-relaxed"
      >
        {children}
      </pre>
      <button
        onClick={handleCopy}
        className={cn(
          "absolute top-2.5 right-2.5 p-1.5 rounded-md transition-all",
          "text-[#EDEDEB]/50 hover:text-[#EDEDEB] hover:bg-white/10",
          copied ? "opacity-100" : "opacity-0 group-hover/code:opacity-100"
        )}
      >
        {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.75} />}
      </button>
    </div>
  )
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  return (
    <div className={cn('prose-solidify', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          h1: ({ children }) => (
            <h1 className="text-2xl font-semibold text-text-primary leading-tight mt-6 mb-3 first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-lg font-semibold text-text-primary mt-6 mb-2">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-base font-semibold text-text-primary mt-4 mb-2">
              {children}
            </h3>
          ),
          p: ({ children }) => (
            <p className="text-sm text-text-secondary leading-relaxed mb-3">
              {children}
            </p>
          ),
          ul: ({ children }) => (
            <ul className="space-y-1.5 text-sm text-text-secondary leading-relaxed list-disc pl-5 mb-3">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="space-y-1.5 text-sm text-text-secondary leading-relaxed list-decimal pl-5 mb-3">
              {children}
            </ol>
          ),
          li: ({ children }) => <li>{children}</li>,
          strong: ({ children }) => (
            <strong className="font-medium text-text-primary">{children}</strong>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-text-link hover:underline"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-accent pl-4 my-3 text-sm text-text-secondary italic">
              {children}
            </blockquote>
          ),
          code: ({ className, children }) => {
            const isBlock = className?.includes('hljs') || className?.includes('language-')
            if (!isBlock) {
              return (
                <code className="bg-accent-light text-accent-hover px-1.5 py-0.5 rounded text-[0.9em] font-mono">
                  {children}
                </code>
              )
            }
            return (
              <code className={cn('text-[13px] font-mono !bg-transparent', className)}>
                {children}
              </code>
            )
          },
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          table: ({ children }) => (
            <div className="overflow-x-auto my-3">
              <table className="w-full text-sm border-collapse">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="border-b border-border">{children}</thead>
          ),
          th: ({ children }) => (
            <th className="text-left px-3 py-2 text-text-primary font-medium text-xs">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-2 text-text-secondary border-b border-border-light">
              {children}
            </td>
          ),
          hr: () => <hr className="border-border-light my-4" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
