#ifdef CHROMA_T_EMBED_CC1101
#include <Arduino.h>
#include <ArduinoJson.h>
#include <AsyncJson.h>
#include <ESPAsyncWebServer.h>
#include <esp_ota_ops.h>
#include <esp_image_format.h>
#include <mbedtls/sha256.h>
#include "firmware_update.h"
#include "studio.h"
#include "RFV3.h"
#include "studio_web.h"

namespace {
const char target_marker[] = STUDIO_FIRMWARE_TARGET STUDIO_VERSION;
const char package_magic[] = "CHROMA5\n";
SemaphoreHandle_t update_mutex;
struct Guard { Guard(){xSemaphoreTake(update_mutex,portMAX_DELAY);} ~Guard(){xSemaphoreGive(update_mutex);} };
struct RequestState { bool accepted,finished; char error[128]; };
struct Transfer {
 AsyncWebServerRequest *owner;
 esp_ota_handle_t handle;
 bool open,active,staged,sha_ready,marker_found;
 uint8_t prefix[12],image_header[32];
 char manifest[1025],version[33],expected_hash[65],token[33],error[128];
 size_t prefix_size,manifest_size,manifest_used,header_size,expected,received,marker_pos;
 uint32_t last_activity;
 mbedtls_sha256_context sha;
} transfer = {};
volatile uint32_t reboot_at=0;
volatile bool resync=false;
int previous_cache=-1;
const esp_partition_t *next_partition(){return esp_ota_get_next_update_partition(nullptr);}
bool previous_available(){
 if(previous_cache>=0)return previous_cache==1;
 const esp_partition_t *other=next_partition();esp_app_desc_t previous,current;
 bool compatible=other&&esp_ota_get_partition_description(other,&previous)==ESP_OK&&esp_ota_get_partition_description(esp_ota_get_running_partition(),&current)==ESP_OK&&strcmp(previous.project_name,current.project_name)==0;
 if(compatible){esp_partition_pos_t position={other->address,other->size};esp_image_metadata_t metadata={};compatible=esp_image_verify(ESP_IMAGE_VERIFY_SILENT,&position,&metadata)==ESP_OK;}
 previous_cache=compatible?1:0;return compatible;
}
void reply_error(AsyncWebServerRequest *request,int status,const String &error){StaticJsonDocument<256> doc;doc["error"]=error;String text;serializeJson(doc,text);request->send(status,"application/json",text);}
void fail(const char *error){
 if(transfer.open)esp_ota_abort(transfer.handle);
 if(transfer.sha_ready)mbedtls_sha256_free(&transfer.sha);
 transfer.open=false;transfer.sha_ready=false;transfer.active=false;transfer.staged=false;transfer.owner=nullptr;
 strlcpy(transfer.error,error,sizeof(transfer.error));studio_end_firmware_update();resync=true;
}
bool authorized(AsyncWebServerRequest *request){return request->hasHeader("X-Chroma-Update")&&request->getHeader("X-Chroma-Update")->value()=="1";}
bool parse_manifest(){
 DynamicJsonDocument doc(1536);
 if(deserializeJson(doc,static_cast<const char *>(transfer.manifest)))return false;
 String version=doc["version"]|"",hash=doc["sha256"]|"";
 const esp_partition_t *partition=next_partition();
 if((doc["format"]|0)!=1||strcmp(doc["board"]|"","lilygo-t-embed-cc1101-plus")||!(doc["embedded_web"]|false)||version.length()<1||version.length()>32||hash.length()!=64||!doc["bytes"].is<unsigned int>()||!partition)return false;
 for(char c:version)if(!isalnum(static_cast<unsigned char>(c))&&c!='.'&&c!='-'&&c!='_')return false;
 for(char c:hash)if(!isxdigit(static_cast<unsigned char>(c)))return false;
 transfer.expected=doc["bytes"].as<size_t>();if(transfer.expected<100000||transfer.expected>partition->size)return false;
 strlcpy(transfer.version,version.c_str(),sizeof(transfer.version));hash.toLowerCase();strlcpy(transfer.expected_hash,hash.c_str(),sizeof(transfer.expected_hash));return true;
}
bool write_image(const uint8_t *data,size_t length){
 if(transfer.received+length>transfer.expected){fail("Package contains extra firmware bytes");return false;}
 if(esp_ota_write(transfer.handle,data,length)!=ESP_OK){fail("Flash write failed; current firmware is unchanged");return false;}
 mbedtls_sha256_update_ret(&transfer.sha,data,length);transfer.received+=length;
 String marker=String(STUDIO_FIRMWARE_TARGET)+transfer.version;
 for(size_t i=0;i<length&&!transfer.marker_found;++i){if(data[i]==static_cast<uint8_t>(marker[transfer.marker_pos])){if(++transfer.marker_pos==marker.length()+1)transfer.marker_found=true;}else transfer.marker_pos=data[i]==marker[0]?1:0;}
 return true;
}
void consume(uint8_t *data,size_t length){
 while(length&&transfer.active){
  if(transfer.prefix_size<12){size_t n=min(length,12-transfer.prefix_size);memcpy(transfer.prefix+transfer.prefix_size,data,n);transfer.prefix_size+=n;data+=n;length-=n;if(transfer.prefix_size<12)continue;
   if(memcmp(transfer.prefix,package_magic,8)){fail("Choose a Chroma Studio .chroma firmware package");return;}
   transfer.manifest_size=transfer.prefix[8]|(transfer.prefix[9]<<8)|(transfer.prefix[10]<<16)|(transfer.prefix[11]<<24);
   if(!transfer.manifest_size||transfer.manifest_size>1024){fail("Invalid package manifest length");return;}
  }else if(transfer.manifest_used<transfer.manifest_size){size_t n=min(length,transfer.manifest_size-transfer.manifest_used);memcpy(transfer.manifest+transfer.manifest_used,data,n);transfer.manifest_used+=n;data+=n;length-=n;
   if(transfer.manifest_used==transfer.manifest_size){transfer.manifest[transfer.manifest_used]=0;if(!parse_manifest()){fail("Package is incompatible with this controller");return;}}
  }else if(transfer.header_size<32){size_t n=min(length,32-transfer.header_size);memcpy(transfer.image_header+transfer.header_size,data,n);transfer.header_size+=n;data+=n;length-=n;
   if(transfer.header_size==32){if(transfer.image_header[0]!=0xe9||transfer.image_header[12]!=9||transfer.image_header[13]!=0){fail("Firmware is not an ESP32-S3 application");return;}
    if(esp_ota_begin(next_partition(),transfer.expected,&transfer.handle)!=ESP_OK){fail("Cannot open the inactive firmware slot");return;}
    previous_cache=-1;transfer.open=true;mbedtls_sha256_init(&transfer.sha);mbedtls_sha256_starts_ret(&transfer.sha,0);transfer.sha_ready=true;if(!write_image(transfer.image_header,32))return;
   }
  }else{write_image(data,length);return;}
 }
}
void complete(){
 if(transfer.received!=transfer.expected||!transfer.sha_ready||!transfer.marker_found){fail("Firmware is incomplete or lacks the Chroma Studio board marker");return;}
 uint8_t hash[32];char hex[65];mbedtls_sha256_finish_ret(&transfer.sha,hash);mbedtls_sha256_free(&transfer.sha);transfer.sha_ready=false;
 for(int i=0;i<32;++i)snprintf(hex+i*2,3,"%02x",hash[i]);
 if(strcmp(hex,transfer.expected_hash)){fail("Firmware checksum mismatch; current firmware is unchanged");return;}
 esp_err_t valid=esp_ota_end(transfer.handle);transfer.open=false;
 if(valid!=ESP_OK){fail("ESP32 firmware validation failed; current firmware is unchanged");return;}
 transfer.active=false;transfer.staged=true;transfer.owner=nullptr;
 for(int i=0;i<4;++i)snprintf(transfer.token+i*8,9,"%08lx",static_cast<unsigned long>(esp_random()));
}
}

void poll_firmware_update(){
 if(!update_mutex)return;
 bool restart_now=false;
 {Guard lock;
 if((transfer.active||transfer.staged)&&millis()-transfer.last_activity>(transfer.staged?120000U:30000U))fail("Firmware upload expired; current firmware is unchanged");
 restart_now=reboot_at&&static_cast<int32_t>(millis()-reboot_at)>=0;
 if(resync){resync=false;studio_discard_radio_edges();set_mode_full_sync();}
 }
 // Wi-Fi shutdown runs disconnect callbacks, which also use update_mutex.
 // Reboot only after releasing it, so those callbacks can finish.
 if(restart_now)ESP.restart();
}
void register_firmware_routes(AsyncWebServer &server){
 update_mutex=xSemaphoreCreateMutex();
 server.on("/",HTTP_GET,[](AsyncWebServerRequest *request){auto *response=request->beginResponse_P(200,"text/html",studio_index,sizeof(studio_index));response->addHeader("Cache-Control","no-store");request->send(response);});
 server.on("/index.htm",HTTP_GET,[](AsyncWebServerRequest *request){request->send_P(200,"text/html",studio_index,sizeof(studio_index));});
 server.on("/app.js",HTTP_GET,[](AsyncWebServerRequest *request){auto *response=request->beginResponse_P(200,"text/javascript",studio_js,sizeof(studio_js));response->addHeader("Content-Encoding","gzip");response->addHeader("Cache-Control","no-store");request->send(response);});
 server.on("/app.css",HTTP_GET,[](AsyncWebServerRequest *request){auto *response=request->beginResponse_P(200,"text/css",studio_css,sizeof(studio_css));response->addHeader("Content-Encoding","gzip");response->addHeader("Cache-Control","no-store");request->send(response);});
 server.on("/api/v1/firmware",HTTP_GET,[](AsyncWebServerRequest *request){Guard lock;DynamicJsonDocument doc(1024);const esp_partition_t *running=esp_ota_get_running_partition(),*next=next_partition();
  doc["version"]=STUDIO_VERSION;doc["target"]=target_marker;doc["board"]="lilygo-t-embed-cc1101-plus";doc["package_format"]=1;doc["embedded_web"]=true;doc["running_slot"]=running?running->label:"";doc["update_slot"]=next?next->label:"";doc["max_bytes"]=next?next->size:0;doc["rollback_available"]=!studio_firmware_busy()&&previous_available();
  doc["status"]=reboot_at?"restarting":transfer.active?"uploading":transfer.staged?"staged":"idle";doc["received"]=transfer.received;doc["expected"]=transfer.expected;doc["last_error"]=String(transfer.error);doc["automatic_rollback"]=false;
  String text;serializeJson(doc,text);request->send(200,"application/json",text);
 });
 server.on("/api/v1/firmware/upload",HTTP_POST,[](AsyncWebServerRequest *request){Guard lock;RequestState *state=static_cast<RequestState *>(request->_tempObject);
  if(!state||!state->accepted||!state->finished||state->error[0]||!transfer.staged){reply_error(request,400,state&&state->error[0]?state->error:transfer.error[0]?transfer.error:"Firmware package was not accepted");return;}
  StaticJsonDocument<256> doc;doc["status"]="staged";doc["token"]=String(transfer.token);doc["version"]=String(transfer.version);String text;serializeJson(doc,text);request->send(200,"application/json",text);
 },[](AsyncWebServerRequest *request,const String &,size_t index,uint8_t *data,size_t length,bool final){Guard lock;
  if(index==0){
   if(request->_tempObject){RequestState *old=static_cast<RequestState *>(request->_tempObject);strlcpy(old->error,"Choose exactly one firmware package",sizeof(old->error));if(old->accepted)fail(old->error);return;}
   RequestState *state=static_cast<RequestState *>(calloc(1,sizeof(RequestState)));request->_tempObject=state;if(!state)return;
   if(!authorized(request)){strlcpy(state->error,"Missing firmware update header",sizeof(state->error));return;}
   String error;if(!studio_begin_firmware_update(error)){strlcpy(state->error,error.c_str(),sizeof(state->error));return;}
   if(transfer.sha_ready)mbedtls_sha256_free(&transfer.sha);transfer={};transfer.active=true;transfer.owner=request;state->accepted=true;
   request->onDisconnect([request](){Guard lock;RequestState *pending=static_cast<RequestState *>(request->_tempObject);if(pending&&pending->accepted&&!pending->finished&&transfer.owner==request)fail("Firmware connection closed; current firmware is unchanged");});
  }
  RequestState *state=static_cast<RequestState *>(request->_tempObject);if(!state||!state->accepted||state->error[0]||!transfer.active)return;
  transfer.last_activity=millis();consume(data,length);
  if(!transfer.active){strlcpy(state->error,transfer.error,sizeof(state->error));state->finished=true;return;}
  if(final){complete();state->finished=true;if(!transfer.staged)strlcpy(state->error,transfer.error,sizeof(state->error));}
 });
 auto *json=new AsyncCallbackJsonWebHandler("/api/v1/firmware",[](AsyncWebServerRequest *request,JsonVariant &body){Guard lock;
  if(!authorized(request)){reply_error(request,403,"Missing firmware update header");return;}
  if(request->url()=="/api/v1/firmware/commit"){
   if(!transfer.staged||body["token"].as<String>()!=transfer.token){reply_error(request,409,"Upload and verify a package before installing");return;}
   if(esp_ota_set_boot_partition(next_partition())!=ESP_OK){fail("Could not select the new firmware slot");reply_error(request,500,transfer.error);return;}
   transfer.staged=false;reboot_at=millis()+1500;request->send(202,"application/json","{\"status\":\"restarting\"}");
  }else if(request->url()=="/api/v1/firmware/rollback"){
   if(!previous_available()){reply_error(request,409,"No compatible previous application is available");return;}
   String error;if(!studio_begin_firmware_update(error)){reply_error(request,409,error);return;}
   if(esp_ota_set_boot_partition(next_partition())!=ESP_OK){studio_end_firmware_update();reply_error(request,500,"Could not select the previous firmware");return;}
   reboot_at=millis()+1500;request->send(202,"application/json","{\"status\":\"restarting\"}");
  }else reply_error(request,404,"Firmware endpoint not found");
 },512);json->setMaxContentLength(512);server.addHandler(json);
}
#endif
