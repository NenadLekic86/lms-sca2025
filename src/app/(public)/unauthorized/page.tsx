'use client';

import Link from 'next/link';
import { ShieldX } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function UnauthorizedPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-6 p-8">
        <div className="flex justify-center">
          <ShieldX className="h-24 w-24 text-destructive" />
        </div>
        
        <h1 className="text-4xl font-bold text-foreground">
          Access Denied
        </h1>
        
        <p className="text-lg text-muted-foreground max-w-md">
          You don&apos;t have permission to access this page. 
          Please contact your administrator if you believe this is an error.
        </p>
        
        <div className="flex gap-4 justify-center">
          <Button asChild>
            <Link href="/">
              Go to Login
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

