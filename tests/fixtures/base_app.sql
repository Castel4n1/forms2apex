prompt --application/set_environment
set define off verify off feedback off
-- Export APEX fictício e mínimo, só com o que o forms2apex lê. Não é código de cliente.
begin
wwv_flow_imp.import_begin (
 p_version_yyyy_mm_dd=>'2026.03.30'
,p_release=>'26.1.0'
,p_default_workspace_id=>1111111111111111
,p_default_application_id=>500
,p_default_id_offset=>2222222222222222
,p_default_owner=>'DEMO'
);
end;
/
begin
wwv_imp_workspace.create_flow(
 p_id=>wwv_flow.g_flow_id
,p_owner=>nvl(wwv_flow_application_install.get_schema,'DEMO')
,p_name=>nvl(wwv_flow_application_install.get_application_name,'Demo')
,p_theme_id=>42
);
end;
/
begin
wwv_flow_imp_shared.create_theme(
 p_id=>wwv_flow_imp.id(900)
,p_theme_id=>7
,p_theme_name=>'Antigo'
,p_default_page_template=>wwv_flow_imp.id(1)
);
end;
/
begin
wwv_flow_imp_shared.create_theme(
 p_id=>wwv_flow_imp.id(901)
,p_theme_id=>42
,p_theme_name=>'Universal Theme'
,p_default_page_template=>wwv_flow_imp.id(101)
,p_default_button_template=>wwv_flow_imp.id(102)
,p_default_region_template=>wwv_flow_imp.id(103)
,p_default_form_template=>wwv_flow_imp.id(104)
,p_default_irr_template=>wwv_flow_imp.id(105)
,p_default_label_template=>wwv_flow_imp.id(106)
,p_default_required_label=>wwv_flow_imp.id(107)
);
end;
/
prompt --application/pages/page_00010
begin
wwv_flow_imp_page.create_page(
 p_id=>10
,p_name=>'Existente'
);
end;
/
prompt --application/pages/page_01000
begin
wwv_flow_imp_page.create_page(
 p_id=>1000
,p_name=>'Outra'
);
end;
/
