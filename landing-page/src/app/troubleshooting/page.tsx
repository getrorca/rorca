'use client';

import { motion } from 'framer-motion';
import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';
import { AlertTriangle, CheckCircle, Terminal, HelpCircle, ChevronRight } from 'lucide-react';
import { useState } from 'react';

interface TroubleshootSection {
  id: string;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  iconColor: string;
  sections: {
    heading: string;
    content: string[];
    code?: string | string[];
  }[];
}

const ISSUES: TroubleshootSection[] = [
  {
    id: 'permission-denied',
    title: 'Permission denied on install script',
    icon: AlertTriangle,
    iconColor: 'text-red-400',
    sections: [
      {
        heading: 'Symptom',
        content: ['When running the install command, you see:', '"bash: ./rorca-macos-arm64: Permission denied"'],
      },
      {
        heading: 'Cause',
        content: ['The downloaded binary doesn\'t have execute permissions. This happens because the shell script or download didn\'t preserve executable flags.'],
      },
      {
        heading: 'Fix',
        content: ['Add execute permission to the binary:'],
        code: 'chmod +x ./rorca-macos-arm64\n./rorca-macos-arm64',
      },
    ],
  },
  {
    id: 'port-3030',
    title: 'Port 3030 already in use',
    icon: Terminal,
    iconColor: 'text-amber-400',
    sections: [
      {
        heading: 'Symptom',
        content: ['Rorca starts but the dashboard fails to load. The terminal shows:', '"Error: listen EADDRINUSE :::3030"', 'Or: "Address already in use: Port 3030"'],
      },
      {
        heading: 'Cause',
        content: ['Another process is already using port 3030. This might be:', '• A previous Rorca instance still running', '• Another development server (Node.js, Python Flask, etc.)', '• System service on that port'],
      },
      {
        heading: 'Fix',
        content: ['Find and kill the process using port 3030:'],
        code: ['# macOS / Linux', 'lsof -ti:3030 | xargs kill -9', '', '# Windows (PowerShell)', 'Get-Process -Id (Get-NetTCPConnection -LocalPort 3030).OwningProcess | Stop-Process -Force'],
      },
    ],
  },
  {
    id: 'port-5433',
    title: 'Port 5433 already in use',
    icon: Terminal,
    iconColor: 'text-amber-400',
    sections: [
      {
        heading: 'Symptom',
        content: ['Rorca fails to start Postgres. The logs show:', '"Error: listen EADDRINUSE :::5433"', 'Or: "initdb failed: address already in use"'],
      },
      {
        heading: 'Cause',
        content: ['Port 5433 (where Rorca provisions its embedded Postgres) is in use by another Postgres instance or service.'],
      },
      {
        heading: 'Fix — Option A: Kill existing Postgres',
        content: ['If you don\'t need the other Postgres instance:'],
        code: 'lsof -ti:5433 | xargs kill -9',
      },
      {
        heading: 'Fix — Option B: Use existing Postgres',
        content: ['If you have Postgres 16 running elsewhere (Docker, local on :5432), point Rorca to it:'],
        code: 'DATABASE_URL="postgres://rorca:rorca@localhost:5432/rorca" rorca start',
      },
    ],
  },
  {
    id: 'node-version',
    title: 'Node.js version too old',
    icon: AlertTriangle,
    iconColor: 'text-red-400',
    sections: [
      {
        heading: 'Symptom',
        content: ['When running rorca start, you see:', '"Rorca requires Node.js 18.0.0 or higher. You have x.y.z"'],
      },
      {
        heading: 'Cause',
        content: ['The Node.js version is below version 18.'],
      },
      {
        heading: 'Fix — Using nvm',
        content: [''],
        code: 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash\nsource ~/.bashrc\nnvm install 18\nnode --version',
      },
      {
        heading: 'Fix — Using volta',
        content: ['Simpler alternative:'],
        code: 'curl https://get.volta.sh | bash\nvolta install node@18\nnode --version',
      },
    ],
  },
  {
    id: 'bun-not-found',
    title: 'Bun not found',
    icon: AlertTriangle,
    iconColor: 'text-red-400',
    sections: [
      {
        heading: 'Symptom',
        content: ['Rorca fails with:', '"Error: bun not found in PATH"', 'Or: "Rorca requires Bun to be installed."'],
      },
      {
        heading: 'Cause',
        content: ['The Rorca binary was built with Bun, but Bun is not installed or not in your system PATH.'],
      },
      {
        heading: 'Fix — Install Bun',
        content: [''],
        code: ['# macOS / Linux', 'curl -fsSL https://bun.sh/install | bash', '', '# Windows (PowerShell)', 'powershell -c "irm bun.sh/install.ps1|iex"'],
      },
      {
        heading: 'Add to PATH',
        content: ['If Bun is installed but not recognized, add it to your shell profile:'],
        code: 'export PATH="$HOME/.bun/bin:$PATH"',
      },
    ],
  },
  {
    id: 'gatekeeper',
    title: 'macOS Gatekeeper blocks binary',
    icon: AlertTriangle,
    iconColor: 'text-red-400',
    sections: [
      {
        heading: 'Symptom',
        content: ['"rorca-macos-arm64" cannot be opened because the developer cannot be verified', 'Or macOS shows a security warning and prevents execution.'],
      },
      {
        heading: 'Cause',
        content: ['macOS Gatekeeper blocks unsigned binaries by default. Rorca\'s standalone binary is not code-signed (requires paid Apple developer certificates).'],
      },
      {
        heading: 'Fix — Remove quarantine attribute',
        content: [''],
        code: 'xattr -d com.apple.quarantine ./rorca-macos-arm64\n./rorca-macos-arm64',
      },
      {
        heading: 'Fix — Allow in System Settings',
        content: ['If xattr doesn\'t work:', '1. Open System Settings → Privacy & Security', '2. Look for "rorca-macos-arm64 was blocked..."', '3. Click Allow'],
      },
    ],
  },
  {
    id: 'smartscreen',
    title: 'Windows SmartScreen warning',
    icon: AlertTriangle,
    iconColor: 'text-amber-400',
    sections: [
      {
        heading: 'Symptom',
        content: ['When running rorca-windows-x64.exe, Windows shows:', '"Windows Defender SmartScreen — Unrecognized app blocked"'],
      },
      {
        heading: 'Cause',
        content: ['Windows SmartScreen blocks unsigned executables. Rorca\'s binary is not code-signed (requires paid certificates).'],
      },
      {
        heading: 'Fix — Click "More info" and allow',
        content: ['1. The SmartScreen warning appears', '2. Click "More info"', '3. Click "Run anyway"', '4. Windows allows execution on future runs'],
      },
      {
        heading: 'Fix — Unblock via PowerShell',
        content: [''],
        code: 'Unblock-File -Path "C:\\Path\\To\\rorca-windows-x64.exe"',
      },
    ],
  },
  {
    id: 'postgres-start',
    title: 'Postgres fails to start',
    icon: AlertTriangle,
    iconColor: 'text-red-400',
    sections: [
      {
        heading: 'Symptom',
        content: ['Rorca starts but Postgres doesn\'t initialize. The logs show:', '"initdb failed"', 'Or: "pg_ctl: could not start server"'],
      },
      {
        heading: 'Cause',
        content: ['Postgres initialization failed due to:', '• Insufficient disk space', '• Permission errors in the Postgres data directory', '• Corrupted Postgres binaries', '• Previous failed initialization'],
      },
      {
        heading: 'Fix — Check disk space',
        content: ['Rorca needs at least 500 MB free space.'],
        code: '# macOS / Linux\ndf -h\n\n# Windows (PowerShell)\nGet-Volume',
      },
      {
        heading: 'Fix — Clear and reinitialize',
        content: ['Delete the Postgres directory and start fresh:'],
        code: ['# macOS / Linux', 'rm -rf ~/.rorca/postgres', 'rorca start', '', '# Windows (PowerShell)', 'Remove-Item -Recurse -Force $env:USERPROFILE\\.rorca\\postgres', 'rorca start'],
      },
    ],
  },
  {
    id: 'econnrefused',
    title: 'ECONNREFUSED localhost:3030',
    icon: AlertTriangle,
    iconColor: 'text-red-400',
    sections: [
      {
        heading: 'Symptom',
        content: ['"Error: ECONNREFUSED — Connection refused 127.0.0.1:3030"', 'Or browser shows: "localhost:3030 refused to connect"'],
      },
      {
        heading: 'Cause',
        content: ['The Rorca backend is not running. This happens when:', '• rorca start was not executed', '• The backend crashed unexpectedly', '• The backend is running on a different port'],
      },
      {
        heading: 'Fix — Start Rorca',
        content: [''],
        code: 'rorca start\n\n# Wait 10–15 seconds for initialization',
      },
      {
        heading: 'Fix — Check if running',
        content: ['Verify the backend is listening on port 3030:'],
        code: ['# macOS / Linux', 'lsof -ti:3030', '', '# Windows (PowerShell)', 'Get-NetTCPConnection -LocalPort 3030'],
      },
    ],
  },
  {
    id: 'migrations',
    title: 'Migration errors',
    icon: AlertTriangle,
    iconColor: 'text-red-400',
    sections: [
      {
        heading: 'Symptom',
        content: ['Rorca fails with:', '"Error: Migration 069 already applied"', 'Or: "Error: No migration found with version X"', 'Or: "Migration failed: column already exists"'],
      },
      {
        heading: 'Cause',
        content: ['Database migrations track schema changes. Errors indicate:', '• A migration was applied twice (version mismatch)', '• Migration files were manually edited or deleted', '• Duplicate migration numbers from parallel branches'],
      },
      {
        heading: 'Fix — Check applied migrations',
        content: [''],
        code: 'psql postgres://rorca:rorca@localhost:5433/rorca -c "SELECT version, redo_statement FROM schema_migrations ORDER BY version;"',
      },
      {
        heading: 'Fix — Clean reinitialize database',
        content: ['For "column already exists" errors:'],
        code: ['# Drop the database', 'psql postgres://rorca:rorca@localhost:5433/postgres -c "DROP DATABASE rorca;"', '', '# Restart Rorca to re-run all migrations', 'rorca start'],
      },
    ],
  },
];

export default function TroubleshootingPage() {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <main className="min-h-screen bg-abyss text-white selection:bg-fizz selection:text-abyss flex flex-col">
      <Nav />
      <div className="pt-32 pb-24 px-6 sm:px-12 mx-auto max-w-4xl w-full flex-grow">

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          className="mb-16 text-center"
        >
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-white/10 bg-white/5 text-xs font-medium text-zinc-400 mb-6">
            <HelpCircle className="w-3.5 h-3.5" />
            Having trouble? We&apos;re here to help.
          </div>
          <h1 className="text-4xl md:text-5xl font-medium tracking-tight mb-5">
            Installation Troubleshooting
          </h1>
          <p className="text-zinc-400 text-lg max-w-2xl mx-auto leading-relaxed">
            If everything is working, you can skip this page. Otherwise, find your issue below and follow the fix.
          </p>
        </motion.div>

        {/* Quick links */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1, ease: 'easeOut' }}
          className="mb-12 p-6 bg-zinc-900/50 border border-white/5 rounded-xl"
        >
          <h2 className="text-sm font-medium text-zinc-300 mb-4 uppercase tracking-widest">Jump to section</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {ISSUES.map((issue) => (
              <a
                key={issue.id}
                href={`#${issue.id}`}
                className="text-sm text-zinc-400 hover:text-white transition-colors flex items-center gap-2 group"
              >
                <ChevronRight className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                {issue.title}
              </a>
            ))}
          </div>
        </motion.div>

        {/* Issues */}
        <div className="space-y-6">
          {ISSUES.map((issue, idx) => {
            const Icon = issue.icon;
            const isExpanded = expandedId === issue.id;

            return (
              <motion.div
                key={issue.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: 0.15 + idx * 0.05 }}
                id={issue.id}
                className="scroll-mt-32"
              >
                <button
                  onClick={() => setExpandedId(isExpanded ? null : issue.id)}
                  className={`w-full flex items-start gap-4 p-6 rounded-xl border transition-all ${
                    isExpanded
                      ? 'bg-white/5 border-white/20'
                      : 'bg-zinc-900/50 border-white/5 hover:border-white/10'
                  }`}
                >
                  <Icon className={`w-5 h-5 flex-shrink-0 mt-1 ${issue.iconColor}`} />
                  <div className="flex-1 text-left">
                    <h3 className="font-medium text-white text-lg">{issue.title}</h3>
                  </div>
                  <ChevronRight className={`w-5 h-5 flex-shrink-0 text-zinc-600 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                </button>

                {isExpanded && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className="p-6 bg-zinc-950/50 border border-t-0 border-white/5 rounded-b-xl space-y-6">
                      {issue.sections.map((sec, secIdx) => (
                        <div key={secIdx} className="space-y-3">
                          <h4 className="font-medium text-white flex items-center gap-2">
                            {sec.heading === 'Fix' || sec.heading.startsWith('Fix —') ? (
                              <CheckCircle className="w-4 h-4 text-emerald-400" />
                            ) : sec.heading === 'Cause' ? (
                              <AlertTriangle className="w-4 h-4 text-amber-400" />
                            ) : (
                              <Terminal className="w-4 h-4 text-blue-400" />
                            )}
                            {sec.heading}
                          </h4>
                          {sec.content.map((line, lineIdx) => (
                            <p key={lineIdx} className="text-zinc-400 text-sm leading-relaxed">
                              {line}
                            </p>
                          ))}
                          {sec.code && (
                            <div className="mt-4 bg-zinc-950 border border-white/5 rounded-lg p-4 font-mono text-xs overflow-auto">
                              {typeof sec.code === 'string' ? (
                                <code className="text-zinc-300">{sec.code}</code>
                              ) : (
                                <code className="text-zinc-300 whitespace-pre-wrap">
                                  {sec.code.join('\n')}
                                </code>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </motion.div>
            );
          })}
        </div>

        {/* Still need help? */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.6, ease: 'easeOut' }}
          className="mt-20 pt-12 border-t border-white/10 text-center"
        >
          <h2 className="text-xl font-medium mb-4">Still not working?</h2>
          <p className="text-zinc-400 text-sm mb-6 max-w-xl mx-auto leading-relaxed">
            If your issue isn&apos;t listed above or the fix didn&apos;t work, we&apos;re here to help. Open an issue on GitHub with your error message and we&apos;ll get back to you quickly.
          </p>
          <a
            href="https://github.com/getrorca/rorca/issues"
            className="inline-flex items-center gap-2 px-6 py-3 bg-white text-zinc-950 hover:bg-zinc-100 rounded-lg font-medium transition-all"
          >
            Open an issue on GitHub
            <ChevronRight className="w-4 h-4" />
          </a>
        </motion.div>
      </div>
      <Footer />
    </main>
  );
}
