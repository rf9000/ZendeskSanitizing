ARG PRESIDIO_ANALYZER_DIGEST
FROM mcr.microsoft.com/presidio-analyzer@${PRESIDIO_ANALYZER_DIGEST}
ARG SPACY_MODEL_VERSION
# Size of the spaCy models: lg (default, 2.3 GiB in memory) or md (0.9 GiB, for a host with little memory; see
# deploy/docker-compose.colocated.yml). SPACY_NLP_FILE must name the nlp file of the same size.
ARG SPACY_MODEL_SIZE=lg
ARG SPACY_NLP_FILE=nlp.yml
RUN pip install --no-cache-dir \
    "https://github.com/explosion/spacy-models/releases/download/da_core_news_${SPACY_MODEL_SIZE}-${SPACY_MODEL_VERSION}/da_core_news_${SPACY_MODEL_SIZE}-${SPACY_MODEL_VERSION}-py3-none-any.whl" \
    "https://github.com/explosion/spacy-models/releases/download/en_core_web_${SPACY_MODEL_SIZE}-${SPACY_MODEL_VERSION}/en_core_web_${SPACY_MODEL_SIZE}-${SPACY_MODEL_VERSION}-py3-none-any.whl" \
    "https://github.com/explosion/spacy-models/releases/download/de_core_news_${SPACY_MODEL_SIZE}-${SPACY_MODEL_VERSION}/de_core_news_${SPACY_MODEL_SIZE}-${SPACY_MODEL_VERSION}-py3-none-any.whl"
COPY config/presidio/${SPACY_NLP_FILE} /app/conf/nlp.yml
COPY config/presidio/recognizers.yml config/presidio/analyzer.yml /app/conf/
ENV NLP_CONF_FILE=/app/conf/nlp.yml \
    RECOGNIZER_REGISTRY_CONF_FILE=/app/conf/recognizers.yml \
    ANALYZER_CONF_FILE=/app/conf/analyzer.yml
