{
  description = "Experimental Chadlands static-resource collector";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          source = pkgs.lib.cleanSourceWith {
            src = ./.;
            filter = path: type:
              let name = baseNameOf path;
              in !(builtins.elem name [ ".git" "node_modules" "artifacts" "result" ]);
          };
          collector = pkgs.buildNpmPackage {
            pname = "chadlands-static-collector";
            version = "0.1.0";
            src = source;
            npmDepsHash = "sha256-ZUQb6i8ol9WiOdRW3nGlwulp8aKadgrCt9eABNfdBGk=";
            dontNpmBuild = true;
            nativeBuildInputs = [ pkgs.makeWrapper ];
            installPhase = ''
              runHook preInstall
              mkdir -p $out/lib/chadlands-static-collector $out/bin
              cp -r node_modules package.json src $out/lib/chadlands-static-collector/
              makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/chadlands-static-collector \
                --add-flags $out/lib/chadlands-static-collector/src/cli.js
              runHook postInstall
            '';
          };
          fontConfig = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
          ociImage = pkgs.dockerTools.buildLayeredImage {
            name = "chadlands-static-collector";
            tag = "latest";
            contents = [ collector pkgs.cacert pkgs.dejavu_fonts ];
            extraCommands = ''
              mkdir -p output tmp
              chmod 0777 output
              chmod 1777 tmp
            '';
            config = {
              Entrypoint = [ "${collector}/bin/chadlands-static-collector" ];
              Env = [
                "COLLECTOR_OUTPUT=/output"
                "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
                "FONTCONFIG_FILE=${fontConfig}"
                "XDG_CACHE_HOME=/tmp"
              ];
              User = "10001:10001";
              WorkingDir = "/output";
              Labels = {
                "org.opencontainers.image.source" = "https://github.com/blogle/chadlands-static-collector";
                "org.opencontainers.image.revision" = self.rev or self.dirtyRev or "dirty";
                "org.opencontainers.image.version" = "0.1.0";
                "org.opencontainers.image.title" = "Chadlands Static Collector";
                "org.opencontainers.image.description" = "Static HTML capture, fragmentation, normalization, and map annotation experiment";
              };
            };
          };
        in {
          default = collector;
          inherit collector ociImage;
        });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/chadlands-static-collector";
        };
      });

      devShells = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in {
          default = pkgs.mkShell {
            packages = [ pkgs.nodejs_22 ];
          };
        });
    };
}
