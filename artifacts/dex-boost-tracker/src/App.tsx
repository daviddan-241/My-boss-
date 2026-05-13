import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { BoostPage } from "@/pages/BoostPage";

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BoostPage />
      <Toaster />
    </QueryClientProvider>
  );
}

export default App;
