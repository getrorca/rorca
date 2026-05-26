'use client';

import { motion } from 'framer-motion';
import { FileText, CheckSquare, Rocket } from 'lucide-react';

const steps = [
  {
    id: '01',
    title: 'Draft',
    description:
      'Turn a brief into a structured spec. The caller or skill writes the draft, and Rorca validates the shape before it becomes canonical.',
    icon: FileText,
  },
  {
    id: '02',
    title: 'Review',
    description:
      'Inspect stories, dependencies, skills, and context. Edit the spec until it is ready to be approved and executed.',
    icon: CheckSquare,
  },
  {
    id: '03',
    title: 'Run',
    description:
      'Execute the approved spec story-by-story. Logs, outcomes, retrieval feedback, and graph signals all feed back into the backend.',
    icon: Rocket,
  },
];

export function HowItWorks() {
  return (
    <section className="py-28 px-6 sm:px-12 mx-auto max-w-7xl relative">
      <div className="text-center mb-20 relative z-10 max-w-3xl mx-auto">
        <p className="text-sm uppercase tracking-[0.24em] text-zinc-500 mb-4">The loop</p>
        <h2 className="text-3xl sm:text-4xl md:text-5xl font-medium tracking-tight text-white mb-6">
          From brief to shipped work.
        </h2>
        <p className="text-zinc-400 text-lg sm:text-xl leading-relaxed">
          Rorca keeps the handoff explicit so every step can be reviewed, replayed, and learned from.
        </p>
      </div>

      <div className="relative z-10">
        <div className="hidden lg:block absolute top-[45px] left-[10%] right-[10%] h-[1px] bg-white/5 -z-10" />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-12 lg:gap-8">
          {steps.map((step, index) => (
            <motion.div
              key={step.id}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: index * 0.12 }}
              className="relative flex flex-col items-center text-center group"
            >
              <div className="w-24 h-24 mb-8 rounded-2xl bg-surface border border-border flex items-center justify-center relative shadow-[0_0_30px_rgba(0,0,0,0.45)] group-hover:border-zinc-500 transition-colors duration-500">
                <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 rounded-2xl" />
                <step.icon className="w-8 h-8 text-zinc-300 group-hover:text-white transition-colors duration-500 relative z-10" strokeWidth={1.5} />
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-12 h-12 bg-accent/18 blur-xl rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
              </div>

              <div className="hidden lg:block absolute top-[45px] left-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-zinc-800 border-2 border-zinc-950 -z-0 group-hover:bg-accent transition-colors duration-500" />

              <div className="flex flex-col items-center max-w-sm">
                <span className="text-accent font-bold tracking-widest text-sm mb-4">{step.id}</span>
                <h3 className="text-2xl font-medium text-white mb-4 tracking-tight">{step.title}</h3>
                <p className="text-zinc-400 leading-relaxed text-base">{step.description}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>

      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[400px] bg-accent/5 blur-[150px] pointer-events-none -z-10 rounded-[100%]" />
    </section>
  );
}
