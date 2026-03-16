'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';
import { Mail, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';

export default function DocsPage() {
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [submitMessage, setSubmitMessage] = useState('');

  const docsUrl = process.env.NEXT_PUBLIC_DOCS_URL;
  const posthogApiKey = process.env.NEXT_PUBLIC_POSTHOG_API_KEY;

  useEffect(() => {
    if (docsUrl) {
      setIsRedirecting(true);
      const timeoutId = setTimeout(() => {
        window.location.href = docsUrl;
      }, 1500);

      return () => clearTimeout(timeoutId);
    }
  }, [docsUrl]);

  const validateEmail = (value: string): boolean => {
    const hasAt = value.includes('@');
    const parts = value.split('@');
    const hasDomain = parts.length === 2 && parts[1].includes('.');
    return hasAt && hasDomain;
  };

  const handleEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setEmail(value);

    if (value && !validateEmail(value)) {
      setEmailError('Please enter a valid email address');
    } else {
      setEmailError('');
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (!validateEmail(email)) {
      setEmailError('Please enter a valid email address');
      return;
    }

    setIsSubmitting(true);
    setSubmitStatus('idle');

    try {
      if (!posthogApiKey) {
        throw new Error('PostHog API key not configured');
      }

      const response = await fetch('https://app.posthog.com/capture/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          api_key: posthogApiKey,
          event: 'docs_notify_signup',
          properties: {
            email,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      setSubmitStatus('success');
      setSubmitMessage('Thanks! We will notify you when docs are ready.');
      setEmail('');
      setEmailError('');

      // Reset success message after 5 seconds
      setTimeout(() => {
        setSubmitStatus('idle');
        setSubmitMessage('');
      }, 5000);
    } catch (error) {
      setSubmitStatus('error');
      setSubmitMessage('Could not save your email. Please try again.');

      // Reset error message after 5 seconds
      setTimeout(() => {
        setSubmitStatus('idle');
        setSubmitMessage('');
      }, 5000);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Render redirecting state
  if (isRedirecting) {
    return (
      <main className="min-h-screen bg-abyss text-white selection:bg-fizz selection:text-abyss flex flex-col">
        <Nav />
        <div className="pt-32 pb-24 px-6 sm:px-12 mx-auto max-w-2xl w-full flex-grow flex items-center justify-center">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5 }}
            className="text-center"
          >
            <div className="mb-6 flex justify-center">
              <div className="animate-spin">
                <Loader2 className="w-8 h-8 text-fizz" />
              </div>
            </div>
            <h1 className="text-3xl font-medium mb-2">Redirecting to documentation...</h1>
            <p className="text-zinc-400">You will be redirected in a moment.</p>
          </motion.div>
        </div>
        <Footer />
      </main>
    );
  }

  // Render coming-soon state
  return (
    <main className="min-h-screen bg-abyss text-white selection:bg-fizz selection:text-abyss flex flex-col">
      <Nav />
      <div className="pt-32 pb-24 px-6 sm:px-12 mx-auto max-w-2xl w-full flex-grow">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          className="text-center mb-12"
        >
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-white/10 bg-white/5 text-xs font-medium text-zinc-400 mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            Coming Soon
          </div>
          <h1 className="text-4xl md:text-5xl font-medium tracking-tight mb-4">
            Documentation coming soon
          </h1>
          <p className="text-zinc-400 text-lg leading-relaxed">
            We're building comprehensive documentation for Rorca. Be the first to know when it's ready.
          </p>
        </motion.div>

        {/* Email Signup Form */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1, ease: 'easeOut' }}
          className="max-w-md mx-auto"
        >
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <div className="relative flex items-center">
                <Mail className="absolute left-4 w-4 h-4 text-zinc-500 pointer-events-none" />
                <input
                  type="email"
                  placeholder="your@email.com"
                  value={email}
                  onChange={handleEmailChange}
                  disabled={isSubmitting || submitStatus === 'success'}
                  className={`w-full pl-11 pr-4 py-3 bg-zinc-900 border rounded-lg text-white placeholder-zinc-500 transition-all focus:outline-none ${
                    emailError
                      ? 'border-red-500/50 focus:border-red-500'
                      : 'border-white/10 focus:border-white/20'
                  } disabled:opacity-50 disabled:cursor-not-allowed`}
                  aria-label="Email address"
                />
              </div>
              {emailError && (
                <p className="text-red-400 text-sm mt-2">{emailError}</p>
              )}
            </div>

            <button
              type="submit"
              disabled={isSubmitting || !email || emailError !== '' || submitStatus === 'success'}
              className={`w-full py-3 rounded-lg font-medium transition-all flex items-center justify-center gap-2 ${
                submitStatus === 'success'
                  ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20'
                  : submitStatus === 'error'
                  ? 'bg-red-500/15 text-red-400 border border-red-500/20'
                  : 'bg-white text-zinc-950 hover:bg-zinc-100'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
              aria-label="Subscribe to documentation notifications"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Saving...</span>
                </>
              ) : submitStatus === 'success' ? (
                <>
                  <CheckCircle className="w-4 h-4" />
                  <span>Subscribed!</span>
                </>
              ) : (
                'Notify me'
              )}
            </button>
          </form>

          {/* Toast Messages */}
          {submitMessage && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.3 }}
              className={`mt-4 flex items-start gap-3 px-4 py-3 rounded-lg text-sm ${
                submitStatus === 'success'
                  ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
                  : 'bg-red-500/10 border border-red-500/20 text-red-400'
              }`}
            >
              {submitStatus === 'success' ? (
                <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              )}
              <span>{submitMessage}</span>
            </motion.div>
          )}
        </motion.div>
      </div>
      <Footer />
    </main>
  );
}
