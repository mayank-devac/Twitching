ARG PLAYWRIGHT_VERSION=1.63.0
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
ARG PLAYWRIGHT_VERSION
WORKDIR /opt/preview
RUN npm install --omit=dev playwright@${PLAYWRIGHT_VERSION}
COPY preview.mjs /opt/preview/preview.mjs
ENV HOME=/tmp/preview-home
USER pwuser
CMD ["node", "/opt/preview/preview.mjs"]
