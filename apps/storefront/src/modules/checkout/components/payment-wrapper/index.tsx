"use client"

import { loadStripe, Stripe } from "@stripe/stripe-js"
import React from "react"
import StripeWrapper from "./stripe-wrapper"
import { HttpTypes } from "@medusajs/types"
import {
  getMedusaPaymentsAccount,
  isMedusaPayments,
  isStripeLike,
} from "@lib/constants"

type PaymentWrapperProps = {
  cart: HttpTypes.StoreCart
  children: React.ReactNode
}

const stripeKey = process.env.NEXT_PUBLIC_STRIPE_KEY
const medusaPaymentsKey =
  process.env.NEXT_PUBLIC_MEDUSA_PAYMENTS_PUBLISHABLE_KEY

// loadStripe should only be called once per configuration, so we cache the promises.
const stripePromises = new Map<string, Promise<Stripe | null>>()

const getStripePromise = (key: string, stripeAccount?: string) => {
  const cacheKey = `${key}:${stripeAccount ?? ""}`
  if (!stripePromises.has(cacheKey)) {
    stripePromises.set(
      cacheKey,
      loadStripe(key, stripeAccount ? { stripeAccount } : undefined)
    )
  }
  return stripePromises.get(cacheKey)!
}

const PaymentWrapper: React.FC<PaymentWrapperProps> = ({ cart, children }) => {
  const paymentSession = cart.payment_collection?.payment_sessions?.find(
    (s) => s.status === "pending"
  )

  if (paymentSession && isStripeLike(paymentSession.provider_id)) {
    // Medusa Payments creates the payment on the account's Stripe connected account,
    // so Stripe.js needs to be initialized for that account.
    const key = isMedusaPayments(paymentSession.provider_id)
      ? medusaPaymentsKey
      : stripeKey
    const stripePromise = key
      ? getStripePromise(key, getMedusaPaymentsAccount(paymentSession))
      : null

    return (
      <StripeWrapper
        paymentSession={paymentSession}
        stripeKey={key}
        stripePromise={stripePromise}
      >
        {children}
      </StripeWrapper>
    )
  }

  return <div>{children}</div>
}

export default PaymentWrapper
