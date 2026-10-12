
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return Response.json(
        { error: "Method not allowed" },
        { status: 405 }
      );
    }

    const {
      STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET,
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      CREDIT_PACKAGES_JSON
    } = process.env;

    if (
      !STRIPE_SECRET_KEY ||
      !STRIPE_WEBHOOK_SECRET ||
      !SUPABASE_URL ||
      !SUPABASE_SERVICE_ROLE_KEY ||
      !CREDIT_PACKAGES_JSON
    ) {
      return Response.json(
        { error: "Webhook not configured" },
        { status: 503 }
      );
    }

    const stripe = new Stripe(STRIPE_SECRET_KEY);

    const signature =
      request.headers.get("stripe-signature");

    if (!signature) {
      return Response.json(
        { error: "Missing Stripe signature" },
        { status: 400 }
      );
    }

    let event;

    try {
      const rawBody = await request.text();

      event = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        STRIPE_WEBHOOK_SECRET
      );

    } catch (error) {
      console.error(
        "Webhook signature verification failed:",
        error.message
      );

      return Response.json(
        { error: "Invalid webhook signature" },
        { status: 400 }
      );
    }

    if (event.type !== "checkout.session.completed") {
      return Response.json({ received: true });
    }

    try {
      const eventSession = event.data.object;

      // Retrieve the canonical session from Stripe.
      const session =
        await stripe.checkout.sessions.retrieve(
          eventSession.id
        );

      if (
        session.mode !== "payment" ||
        session.status !== "complete" ||
        session.payment_status !== "paid"
      ) {
        return Response.json({
          received: true,
          credited: false
        });
      }

      const userId = session.metadata?.user_id;
      const packageId =
        session.metadata?.package_id;
      const priceId =
        session.metadata?.price_id;

      const packages =
        JSON.parse(CREDIT_PACKAGES_JSON);

      const selected = packages[packageId];

      if (
        !selected ||
        selected.priceId !== priceId ||
        !Number.isSafeInteger(selected.credits) ||
        selected.credits <= 0 ||
        session.client_reference_id !== userId ||
        session.metadata?.credits !==
          String(selected.credits)
      ) {
        throw new Error(
          "Invalid purchase metadata"
        );
      }

      const lineItems =
        await stripe.checkout.sessions.listLineItems(
          session.id,
          { limit: 10 }
        );

      if (
        lineItems.data.length !== 1 ||
        lineItems.has_more ||
        lineItems.data[0].price?.id !== priceId ||
        lineItems.data[0].quantity !== 1
      ) {
        throw new Error(
          "Checkout line items do not match package"
        );
      }

      const price =
        await stripe.prices.retrieve(priceId);

      if (
        price.currency !== "usd" ||
        price.type !== "one_time" ||
        !Number.isSafeInteger(price.unit_amount) ||
        session.amount_total !== price.unit_amount ||
        session.currency !== "usd"
      ) {
        throw new Error(
          "Checkout payment amount mismatch"
        );
      }

      const supabase = createClient(
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY,
        {
          auth: {
            persistSession: false,
            autoRefreshToken: false
          }
        }
      );

      // This database RPC must atomically:
      // 1. Record the unique Stripe session.
      // 2. Increase the user's credit balance.
      // 3. Do nothing if already processed.
      const { data, error } =
        await supabase.rpc(
          "fulfill_credit_purchase",
          {
            p_session_id: session.id,
            p_user_id: userId,
            p_package_id: packageId,
            p_credits: selected.credits,
            p_amount_cents: session.amount_total,
            p_currency: session.currency
          }
        );

      if (error) {
        throw error;
      }

      return Response.json({
        received: true,
        result: data
      });

    } catch (error) {
      console.error(
        "Credit fulfillment failed:",
        error
      );

      // A non-2xx response allows Stripe to retry.
      return Response.json(
        { error: "Fulfillment failed" },
        { status: 500 }
      );
    }
  }
};
