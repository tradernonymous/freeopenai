# The Antigravity proxy, pinned to one upstream release, plus the only things the
# published image cannot do: start with accounts already in place, and carry the
# client-version header fix from the archived repo's final tag.
#
# Pinned rather than tracking :latest, because the model ids it serves drift
# between releases and our provider pins the list it answers to -- a silent
# upstream change would look like a bug in this app.
FROM frieserpaldi/antigravity-proxy:0.7.0

# The upstream repo (frieser/antigravity-proxy) was archived on Aug 2026, so the
# v1.7.1 header fix will never ship as an image: its only change is the client
# version the proxy impersonates, 1.15.8 -> 2.0.1 (Google's API began rejecting
# the older client with 400 "Request contains an invalid argument" and
# 403 "Verify your account" -- which is exactly how a datacenter deployment
# fails while the same accounts keep working from a residential IP). Applied
# here at build time rather than maintaining a fork, and only the literal old
# string is replaced, so a future base-image update with the fix already in
# place is left untouched.
USER root
RUN sed -i 's/const ANTIGRAVITY_VERSION = "1.15.8"/const ANTIGRAVITY_VERSION = "2.0.1"/' /app/src/utils/headers.ts \
  && grep -q 'ANTIGRAVITY_VERSION = "2.0.1"' /app/src/utils/headers.ts \
  || (echo "header version patch failed — base image layout changed" && exit 1)

# The upstream image runs as `bun` and owns /app/data. Seeding the account file
# is a write into a path that a mounted volume may own as root, so this runs as
# root to make that write dependable, then hands straight to the proxy. It is a
# private service with no inbound exposure, which is what makes that trade
# acceptable; if you ever give it a public domain, put authentication in front
# first (the proxy has none of its own).
COPY entrypoint.sh /usr/local/bin/antigravity-entrypoint
RUN chmod +x /usr/local/bin/antigravity-entrypoint

ENTRYPOINT ["/usr/local/bin/antigravity-entrypoint"]
