import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

const badgeVariants = cva(
  'inline-flex items-center justify-center rounded-full border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 transition-[color,box-shadow]',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-white',
        outline: 'text-foreground',
        brand: 'border-transparent bg-brand/10 text-brand',
        entry: 'border-transparent bg-blue-500/10 text-blue-600 dark:text-blue-400',
        core: 'border-transparent bg-brand/10 text-brand',
        util: 'border-transparent bg-green-500/10 text-green-600 dark:text-green-400',
        config: 'border-transparent bg-purple-500/10 text-purple-600 dark:text-purple-400',
        test: 'border-transparent bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'span';
  return <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
