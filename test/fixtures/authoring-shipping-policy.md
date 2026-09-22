# Shipping capability acceptance material

This is a synthetic software acceptance fixture, not a real merchant policy.

Calculate shipping independently for each order. The order ID is the unique business key.
The input amount is a non-negative whole number of yuan.

For an order amount of 200 yuan or more, shipping is 0 yuan.
For an order amount below 200 yuan, shipping is 12 yuan.

If the amount is missing, negative, or fractional, do not conclude a shipping fee.
The same rule applies to every order; region, membership, and time do not change it.
