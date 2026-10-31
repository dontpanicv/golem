import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * The Markdown of a search result, inside the row that opens it: its links and pictures show as their text, so it
 * holds no link of its own. Without `rehype-raw`, any HTML in it shows as text.
 */
export default function Snippet({ text }: { text: string }) {
  return (
    <div className="prose search-snippet">
      <ReactMarkdown
        components={{
          a: ({ children }) => <span>{children}</span>,
          img: ({ alt }) => <span>{alt}</span>,
        }}
        remarkPlugins={[remarkGfm]}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
