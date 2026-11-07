import { Dashboard } from "@/components/dashboard/dashboard";

export default function Home() {
  // Only public, non-secret values are passed to the browser.
  const phoneNumber = process.env.TWILIO_PHONE_NUMBER ?? "";
  const customerFirstName = process.env.CUSTOMER_FIRST_NAME ?? "";
  const riskThreshold = Number(process.env.RISK_THRESHOLD) || 70;
  return <Dashboard phoneNumber={phoneNumber} customerFirstName={customerFirstName} riskThreshold={riskThreshold} />;
}
