<div class="flex min-h-screen">
  <!-- Left: Form area -->
  <div class="flex flex-1 flex-col bg-background px-6 py-10">
    <!-- Logo: visible on mobile only -->
    <div class="mb-10 lg:hidden">
      <span class="text-xl font-bold">Arc Launchpad</span>
    </div>

    <div class="flex flex-1 flex-col items-center justify-center">
      <div class="w-full max-w-md">
        <slot />
      </div>
    </div>
  </div>

  <!-- Right: Branding panel (hidden on mobile) -->
  <div class="hidden lg:flex lg:w-[40%] flex-col items-center justify-center border-l bg-card">
    <div class="flex flex-col items-center justify-center -translate-y-6">
      <img src="/images/arc_logo.png" alt="Arc" class="h-64 w-64 object-contain" />
      <span class="-mt-20 text-4xl font-bold">Launchpad</span>
      <p class="mt-4 max-w-sm text-center text-muted-foreground">
        The High-Performance Columnar Analytical Database for product analytics, observability, AI agents, IoT, or data warehousing.
      </p>
    </div>
  </div>
</div>
