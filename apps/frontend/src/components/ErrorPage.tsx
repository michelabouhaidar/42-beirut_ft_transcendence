import { AlertTriangle, ArrowLeft, Home, ShieldAlert } from "lucide-react";
import { useApp } from "../context/AppContext";
import { Button } from "./Button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "./Card";

interface ErrorPageProps {
  code: "403" | "404";
  title?: string;
  message?: string;
  /** Where "Return to Workspace" goes. */
  home: string;
}

export function ErrorPage({ code, title, message, home }: ErrorPageProps) {
  const { navigate } = useApp();
  const is403 = code === "403";
  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-dark-bg text-zinc-900 dark:text-zinc-100 flex items-center justify-center p-4 sm:p-6 font-sans">
      <Card className="max-w-md w-full border border-zinc-200 dark:border-dark-border shadow-sm">
        <CardHeader className="text-center pb-2">
          <div className="mx-auto mb-4 h-12 w-12 flex items-center justify-center rounded-none bg-destructive-50 dark:bg-destructive-950/40 text-destructive-600 border border-destructive-200 dark:border-destructive-900/60">
            {is403 ? <ShieldAlert className="h-6 w-6" /> : <AlertTriangle className="h-6 w-6" />}
          </div>
          <CardTitle className="text-xl sm:text-2xl font-bold font-sans">{title || (is403 ? "Access forbidden" : "Page not found")}</CardTitle>
          <CardDescription className="text-xs sm:text-sm text-zinc-600 dark:text-zinc-400 mt-2 font-sans">
            {message ||
              (is403
                ? "You do not have the required permissions to access this page or resource according to your current role."
                : "The page you are looking for does not exist or has been moved.")}
          </CardDescription>
        </CardHeader>
        <CardFooter className="flex flex-col sm:flex-row gap-2 pt-4">
          <Button variant="outline" fullWidth onClick={() => window.history.back()} leftIcon={<ArrowLeft className="w-4 h-4" />}>
            Go Back
          </Button>
          <Button fullWidth onClick={() => navigate(home)} leftIcon={<Home className="w-4 h-4" />}>
            Return to Workspace
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
