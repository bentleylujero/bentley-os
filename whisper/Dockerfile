FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y git build-essential cmake curl && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git .
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --config Release -j --target whisper-server
RUN mkdir -p models && curl -L -o models/ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y libgomp1 curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /build/build/bin/ ./bin/
COPY --from=build /build/models/ggml-base.bin ./models/ggml-base.bin
ENV LD_LIBRARY_PATH=/app/bin
EXPOSE 4300
CMD ["./bin/whisper-server", "-m", "models/ggml-base.bin", "--host", "0.0.0.0", "--port", "4300"]
