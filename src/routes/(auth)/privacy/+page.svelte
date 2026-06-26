<svelte:head>
  <title>Privacy Policy - Arc Launchpad</title>
</svelte:head>

<div class="mx-auto max-w-2xl py-8">
  <h1 class="text-3xl font-bold">Privacy Policy</h1>
  <p class="mt-2 text-sm text-muted-foreground">Effective date: March 23, 2026</p>

  <div class="mt-8 space-y-6 text-sm leading-relaxed text-muted-foreground">
    <section>
      <h2 class="mb-2 text-lg font-semibold text-foreground">1. Introduction</h2>
      <p>
        Arc Launchpad is operated by Basekick Labs LLC, a Delaware limited liability company ("we", "us", "our").
        This Privacy Policy explains how we collect, use, and protect your information when you use Arc Launchpad.
      </p>
    </section>

    <section>
      <h2 class="mb-2 text-lg font-semibold text-foreground">2. Information We Collect</h2>
      <p class="mb-2"><span class="font-medium text-foreground">Account information:</span> name, email address, and authentication credentials, stored in the local database of the Arc Launchpad instance you connect to.</p>
      <p><span class="font-medium text-foreground">Connection details:</span> Arc Launchpad stores the endpoint URL and admin token of the Arc instances you connect to. Your actual database contents live in your own Arc instances — Arc Launchpad does not host or store that data.</p>
    </section>

    <section>
      <h2 class="mb-2 text-lg font-semibold text-foreground">3. How We Use Your Information</h2>
      <ul class="list-disc space-y-1 pl-5">
        <li>Provide, operate, and maintain Arc</li>
        <li>Send transactional emails (verification, password reset, instance notifications)</li>
        <li>Respond to support requests</li>
        <li>Monitor and improve service performance and security</li>
        <li>Comply with legal obligations</li>
      </ul>
      <p class="mt-2">We do not sell your personal information to third parties. We do not use your data for advertising.</p>
    </section>

    <section>
      <h2 class="mb-2 text-lg font-semibold text-foreground">4. Data Storage & Security</h2>
      <p>
        Arc Launchpad is self-hosted: account data and connection details are stored in the local database
        of the deployment you use, under the control of whoever operates that deployment. Passwords are
        hashed and connections to your Arc instances are made over the network you configure. Securing the
        host, database file, and transport (e.g. TLS) is the responsibility of the operator running this
        Arc Launchpad instance.
      </p>
    </section>

    <section>
      <h2 class="mb-2 text-lg font-semibold text-foreground">5. Third-Party Services</h2>
      <p class="mb-2">We may use the following third-party services to operate Arc Launchpad:</p>
      <ul class="list-disc space-y-1 pl-5">
        <li><span class="font-medium text-foreground">Mailgun</span> &mdash; transactional email delivery</li>
      </ul>
      <p class="mt-2">Each service processes data in accordance with their own privacy policies.</p>
    </section>

    <section>
      <h2 class="mb-2 text-lg font-semibold text-foreground">6. Data Retention</h2>
      <ul class="list-disc space-y-1 pl-5">
        <li>Account data is retained while your account is active and deleted upon request.</li>
        <li>Instance data is deleted when an instance is terminated.</li>
        <li>Backups are retained for up to 30 days after deletion.</li>
      </ul>
    </section>

    <section>
      <h2 class="mb-2 text-lg font-semibold text-foreground">7. Your Rights</h2>
      <p class="mb-2">You have the right to:</p>
      <ul class="list-disc space-y-1 pl-5">
        <li>Access the personal data we hold about you</li>
        <li>Correct inaccurate personal data</li>
        <li>Request deletion of your account and associated data</li>
        <li>Export your instance data at any time via the Arc Launchpad API</li>
      </ul>
      <p class="mt-2">To exercise any of these rights, contact us at <a href="mailto:support@basekick.net" class="text-primary hover:underline">support@basekick.net</a>.</p>
    </section>

    <section>
      <h2 class="mb-2 text-lg font-semibold text-foreground">8. Cookies & Analytics</h2>
      <p class="mb-2">
        Arc Launchpad uses a session cookie (<code class="rounded bg-muted px-1 py-0.5">arc_session</code>) for authentication.
        We do not use advertising cookies.
      </p>
    </section>

    <section>
      <h2 class="mb-2 text-lg font-semibold text-foreground">9. Changes to This Policy</h2>
      <p>
        We may update this Privacy Policy from time to time. If we make material changes, we will notify you
        by email. Continued use of Arc Launchpad after changes constitutes acceptance of the updated policy.
      </p>
    </section>

    <section>
      <h2 class="mb-2 text-lg font-semibold text-foreground">10. Contact</h2>
      <p>
        If you have questions about this Privacy Policy, contact us at
        <a href="mailto:support@basekick.net" class="text-primary hover:underline">support@basekick.net</a>.
      </p>
      <p class="mt-2">
        Basekick Labs LLC<br />
        Delaware, United States
      </p>
    </section>
  </div>

  <div class="mt-8">
    <a href="/login" class="text-sm text-primary hover:underline">&larr; Back to Sign In</a>
  </div>
</div>
