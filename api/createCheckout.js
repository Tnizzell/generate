
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

    try {
      const {
        STRIPE_SECRET_KEY,
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY,
        SITE_URL,
        CREDIT_PACKAGES_JSON
      } = process.env;

      if (
        !STRIPE_SECRET_KEY ||
        !SUPABASE_URL ||
        !SUPABASE_SERVICE_ROLE_KEY ||
        !SITE_URL ||
        !CREDIT_PACKAGES_JSON
      ) {
        return Response.json(
          { error: "Payment system not configured" },
          { status: 503 }
        );
      }

      const authHeader =
        request.headers.get("authorization") || "";

      const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : null;

      if (!token) {
        return Response.json(
          { error: "Please sign in first" },
          { status: 401 }
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

      const { data, error } =
        await supabase.auth.getUser(token);

      if (error || !data?.user) {
        return Response.json(
          { error: "Invalid or expired session" },
          { status: 401 }
        );
      }

      const body = await request.json();
      const packageId = body?.packageId;

      if (
        typeof packageId !== "string" ||
        !/^[a-zA-Z0-9_-]{1,40}$/.test(packageId)
      ) {
        return Response.json(
          { error: "Invalid package" },
          { status: 400 }
        );
      }

      const packages = JSON.parse(
        CREDIT_PACKAGES_JSON
      );

      const selected = packages[packageId];

      if (
        !selected ||
        !Number.isSafeInteger(selected.credits) ||
        selected.credits <= 0 ||
        !/^price_[a-zA-Z0-9]+$/.test(
          selected.priceId || ""
        )
      ) {
        return Response.json(
          { error: "Package unavailable" },
          { status: 400 }
        );
      }

      const site = new URL(SITE_URL);

      if (site.protocol !== "https:") {
        throw new Error("SITE_URL must use HTTPS");
      }

      const stripe = new Stripe(
        STRIPE_SECRET_KEY
      );

      // Verify the Stripe price against the
      // server-side package configuration.
      const price = await stripe.prices.retrieve(
        selected.priceId
      );

      if (
        !price.active ||
        price.type !== "one_time" ||
        price.currency !== "usd" ||
        !Number.isSafeInteger(price.unit_amount) ||
        price.unit_amount <= 0
      ) {
        return Response.json(
          { error: "Package price unavailable" },
          { status: 400 }
        );
      }

      const session =
        await stripe.checkout.sessions.create({
          mode: "payment",

          payment_method_types: ["card"],

          line_items: [
            {
              price: selected.priceId,
              quantity: 1
            }
          ],

          client_reference_id: data.user.id,

          customer_email: data.user.email,

          metadata: {
            user_id: data.user.id,
            package_id: packageId,
            credits: String(selected.credits),
            price_id: selected.priceId
          },

          success_url:
            new URL(
              "/?checkout=success&session_id={CHECKOUT_SESSION_ID}",
              site
            ).toString(),

          cancel_url:
            new URL(
              "/?checkout=cancelled",
              site
            ).toString()
        });

      return Response.json({
        url: session.url
      });

    } catch (error) {
      console.error("Checkout error:", error);

      return Response.json(
        { error: "Unable to start checkout" },
        { status: 500 }
      );
    }
  }
};
