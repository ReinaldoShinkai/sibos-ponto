import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  // Fall back to placeholders when env vars are absent/empty (e.g. during SSR
  // at build time on Vercel before env vars are set). Actual Supabase queries
  // only run inside useEffect (browser-only), so the placeholder is never used.
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-anon-key'
  )
}
