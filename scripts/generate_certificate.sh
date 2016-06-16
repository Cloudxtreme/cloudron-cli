#!/bin/bash

set -eu -o pipefail

# C                      = US
# ST                     = California
# L                      = San Francisco
# O                      = Selfhost
# OU                     = Cloudron
# CN                     = *.nebulon.cloudron.com
# emailAddress           = cert@selfhost.io

if [[ $# < 8 ]]; then
    echo "Not enough arguments"
    exit 1
fi

readonly ARG_C=$1
readonly ARG_ST=$2
readonly ARG_L=$3
readonly ARG_O=$4
readonly ARG_OU=$5
readonly ARG_CN=$6
readonly ARG_EMAIL=$7

readonly CONFIG_FILE=cert.config
OUT_TAR=cert.tar

CERT_OUT_DIR=$8

echo ""
echo "===================================";
echo " Generating certifcate:";
echo "   C:     $ARG_C";
echo "   ST:    $ARG_ST";
echo "   L:     $ARG_L";
echo "   O:     $ARG_O";
echo "   OU:    $ARG_OU";
echo "   CN:    $ARG_CN";
echo "   EMAIL: $ARG_EMAIL";
echo "===================================";
echo "";

# ensure out dir
mkdir -p $CERT_OUT_DIR

# cd into out dir
cd $CERT_OUT_DIR

# clean out dir
rm -f host.*
rm -f $CONFIG_FILE

# generate config file
cat > $CONFIG_FILE <<EOF
[ req ]
default_bits           = 1024
default_keyfile        = keyfile.pem
distinguished_name     = req_distinguished_name
prompt                 = no
req_extensions         = v3_req

[ req_distinguished_name ]
C                      = $ARG_C
ST                     = $ARG_ST
L                      = $ARG_L
O                      = $ARG_O
OU                     = $ARG_OU
CN                     = $ARG_CN
emailAddress           = $ARG_EMAIL

[ v3_req ]
# Extensions to add to a certificate request
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
subjectAltName = @alt_names

[alt_names]
DNS.1 = $ARG_CN
DNS.2 = *.$ARG_CN
EOF

# generate cert files
openssl genrsa 2048 > host.key

openssl req -new -out host.csr -key host.key -config $CONFIG_FILE
openssl x509 -req -days 3650 -in host.csr -signkey host.key -out host.cert -extensions v3_req -extfile $CONFIG_FILE
openssl x509 -noout -fingerprint -text < host.cert > host.info
cat host.cert host.key > host.pem

echo "Done."
